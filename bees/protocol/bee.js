// The protocol bee: k6 users asking for the store's pages over HTTP, writing the same `bee/1` lines as the browser bee.
// With a BEE_MIX that orders, a user is a stream of shoppers who browse, fill a guest cart over Magento's REST API, or check out.
// k6 users share no state, so each histogram bucket is a k6 counter that k6 adds up across users.
import http from 'k6/http'
import { Counter } from 'k6/metrics'

// These three repeat src/bee/histogram.ts, which k6 cannot import; a unit test holds them equal.
const FIRST_BOUND_MS = 1
const GROWTH = 1.25
const BUCKETS = 50

// Codes a store answers often get their own counter; anything else is counted as `other`.
const STATUSES = [
	'200',
	'301',
	'302',
	'304',
	'400',
	'403',
	'404',
	'429',
	'500',
	'502',
	'503',
	'504',
]

// mix: begin (repeats src/bee/mix.ts, src/bee/lines.ts and src/bee/config.ts; a unit test runs this block and holds it equal)
const NORMAL_DAY_ORDER = 0.0162
const CART_ABANDONMENT = 0.7022
const normalDayCarts = NORMAL_DAY_ORDER / (1 - CART_ABANDONMENT)

const MIXES = {
	browse: { browse: 1, cart: 0, order: 0 },
	'normal-day': {
		browse: 1 - normalDayCarts,
		cart: normalDayCarts - NORMAL_DAY_ORDER,
		order: NORMAL_DAY_ORDER,
	},
	'checkout-stress': { browse: 0.6, cart: 0, order: 0.4 },
}

const JOURNEY_PREFIX = 'journey:'

// One stage per REST request of a checkout; each is a name CHECKOUT_STAGES lists.
const REST_STAGES = ['cart-create', 'cart', 'shipping-estimate', 'shipping', 'place-order']

const journeyFor = (mix, roll) => {
	if (roll < mix.order) return 'order'
	if (roll < mix.order + mix.cart) return 'cart'
	return 'browse'
}

// The mix a bee was told to run, or the reason it must not start: nothing can take back an order.
const mixFrom = env => {
	const name = env.BEE_MIX === undefined || env.BEE_MIX === '' ? 'browse' : env.BEE_MIX
	if (!Object.prototype.hasOwnProperty.call(MIXES, name)) {
		throw new Error(`BEE_MIX must be one of ${Object.keys(MIXES).join(', ')}, not "${name}"`)
	}
	const mix = MIXES[name]
	const sku = env.BEE_CART_SKU === '' ? undefined : env.BEE_CART_SKU
	if (mix.browse < 1 && sku === undefined) {
		throw new Error(`BEE_MIX ${name} puts products in carts, and BEE_CART_SKU names none`)
	}
	if (mix.order > 0 && env.BEE_DISPOSABLE !== '1') {
		throw new Error(`BEE_MIX ${name} places orders, and BEE_DISPOSABLE is not 1`)
	}
	return { name, mix, sku }
}
// mix: end

const base = __ENV.BEE_URL.endsWith('/') ? __ENV.BEE_URL : `${__ENV.BEE_URL}/`
const paths = JSON.parse(__ENV.BEE_PATHS)
const users = Math.floor(Number(__ENV.BEE_CONCURRENCY))
const seconds = Math.floor(Number(__ENV.BEE_SECONDS))
const { name: mixName, mix, sku } = mixFrom(__ENV)
const ordering = mix.browse < 1

// Pages first, as they have always been numbered; a mix adds the REST steps and the journeys after them.
const stages = [
	...paths.map(path => path.stage),
	...(ordering
		? [...REST_STAGES, ...['browse', 'cart', 'order'].map(journey => JOURNEY_PREFIX + journey)]
		: []),
]
const slot = Object.fromEntries(stages.map((stage, s) => [stage, s]))

const bucketOf = ms => {
	if (!(ms > FIRST_BOUND_MS)) return 0
	return Math.min(Math.ceil(Math.log(ms / FIRST_BOUND_MS) / Math.log(GROWTH)), BUCKETS - 1)
}

const range = n => Array.from({ length: n }, (_, i) => i)

const counters = stages.map((_, s) => ({
	count: new Counter(`s${s}_count`),
	failures: new Counter(`s${s}_failures`),
	ttfb: range(BUCKETS).map(b => new Counter(`s${s}_ttfb_${b}`)),
	total: range(BUCKETS).map(b => new Counter(`s${s}_total_${b}`)),
	statuses: Object.fromEntries(
		[...STATUSES, 'other', 'error'].map(code => [code, new Counter(`s${s}_status_${code}`)]),
	),
}))

export const options = {
	scenarios: {
		bee: {
			executor: 'constant-vus',
			vus: users,
			duration: `${seconds}s`,
			// A checkout begun just before the end is let finish rather than counted as the store failing.
			gracefulStop: ordering ? '60s' : '5s',
		},
	},
	discardResponseBodies: true,
	summaryTrendStats: ['avg'],
}

// Counts one request, or one journey, against a stage. A status of 0 is no response at all.
const tally = (s, status, ttfb, total) => {
	const c = counters[s]
	c.count.add(1)
	if (status < 200 || status >= 400) c.failures.add(1)
	const code = status === 0 ? 'error' : String(status)
	c.statuses[STATUSES.includes(code) || code === 'error' ? code : 'other'].add(1)
	if (status !== 0) {
		if (ttfb !== undefined) c.ttfb[bucketOf(ttfb)].add(1)
		c.total[bucketOf(total)].add(1)
	}
}

const note = (s, response) =>
	tally(s, response.status, response.timings.waiting, response.timings.duration)

const served = response => response.status >= 200 && response.status < 400

const visit = s =>
	http.get(base + paths[s].path.replace(/^\//, ''), { tags: { stage: paths[s].stage } })

// Thrown when a step of a journey fails, after the step has been counted; the journey stops there.
const STEP_FAILED = { failed: true }

const TEXT = { responseType: 'text' }
const JSON_HEADERS = { 'Content-Type': 'application/json' }

// One REST request as a stage of its own. Bodies are discarded unless the caller needs to read them.
const call = (stage, path, body, params) => {
	const response = http.post(
		`${base}rest/V1/${path}`,
		body === undefined ? null : JSON.stringify(body),
		{ headers: JSON_HEADERS, tags: { stage }, timeout: '30s', ...params },
	)
	note(slot[stage], response)
	return response
}

const jsonOf = response => {
	try {
		return response.body ? JSON.parse(response.body) : undefined
	} catch {
		return undefined
	}
}

// What a step needs from a served response. A 2xx the bee cannot use, such as an empty list of shipping methods, still counts as that step failing.
const usable = (stage, response, value) => {
	if (!served(response)) throw STEP_FAILED
	if (value === undefined || value === null || value === '') {
		counters[slot[stage]].failures.add(1)
		throw STEP_FAILED
	}
	return value
}

// An invented guest in an invented place; the store only has to accept the address.
const shopperAddress = () => ({
	firstname: 'Drex',
	lastname: 'Bot',
	email: `drexbot-bee-${Math.random().toString(16).slice(2, 10)}@drexbot.test`,
	street: ['123 Test Street'],
	city: 'Austin',
	region: 'Texas',
	region_code: 'TX',
	region_id: 57,
	postcode: '78701',
	country_id: 'US',
	telephone: '5125550100',
})

// A new guest cart holding one of the product; returns its id and the store's answer to the add.
const fillCart = () => {
	const created = call('cart-create', 'guest-carts', undefined, TEXT)
	const id = usable('cart-create', created, jsonOf(created))
	const added = call('cart', `guest-carts/${encodeURIComponent(id)}/items`, {
		cartItem: { sku, qty: 1, quote_id: id },
	})
	usable('cart', added, true)
	return { id, added }
}

// From a cart holding a row to an order paid by Check / Money order, so no card number is ever sent.
const checkout = id => {
	const cart = `guest-carts/${encodeURIComponent(id)}`
	const address = shopperAddress()
	const estimate = call('shipping-estimate', `${cart}/estimate-shipping-methods`, { address }, TEXT)
	const methods = jsonOf(estimate)
	const method = usable(
		'shipping-estimate',
		estimate,
		Array.isArray(methods)
			? methods.find(m => m.available !== false && m.carrier_code && m.method_code)
			: undefined,
	)
	const saved = call('shipping', `${cart}/shipping-information`, {
		addressInformation: {
			shipping_address: address,
			billing_address: address,
			shipping_carrier_code: method.carrier_code,
			shipping_method_code: method.method_code,
		},
	})
	usable('shipping', saved, true)
	const placed = call('place-order', `${cart}/payment-information`, {
		email: address.email,
		paymentMethod: { method: 'checkmo' },
		billing_address: address,
	})
	usable('place-order', placed, true)
	return placed
}

// One shopper: every page once, a cart left behind, or an order. The journey's own sample carries the status
// its last step ended on, or none when any step failed.
const shop = journey => {
	const started = Date.now()
	let status = 0
	try {
		if (journey === 'browse') {
			let last
			let allServed = true
			paths.forEach((_, s) => {
				last = visit(s)
				note(s, last)
				if (!served(last)) allServed = false
			})
			status = allServed ? last.status : 0
		} else {
			const { id, added } = fillCart()
			status = journey === 'order' ? checkout(id).status : added.status
		}
	} catch (cause) {
		if (cause !== STEP_FAILED) throw cause
	}
	tally(slot[JOURNEY_PREFIX + journey], status, undefined, Date.now() - started)
}

export default function () {
	if (!ordering) {
		const s = (__VU + __ITER) % paths.length
		note(s, visit(s))
		return
	}
	shop(journeyFor(mix, Math.random()))
}

const countIn = (data, name) => data.metrics[name]?.values?.count ?? 0

const sparse = (data, prefix) =>
	Object.fromEntries(
		range(BUCKETS)
			.map(b => [String(b), countIn(data, `${prefix}_${b}`)])
			.filter(([, count]) => count > 0),
	)

// k6 prints the lines here, at the end, because a virtual user cannot see the others' counts.
export function handleSummary(data) {
	const identity = { drexbot: 'bee/1', run: __ENV.BEE_RUN, bee: __ENV.BEE_ID, kind: 'protocol' }
	const now = new Date()
	const started = new Date(now.getTime() - data.state.testRunDurationMs)
	const lines = [
		{
			...identity,
			event: 'started',
			at: started.toISOString(),
			concurrency: users,
			...(ordering ? { note: `mix ${mixName}` } : {}),
		},
	]
	stages.forEach((stage, s) => {
		const count = countIn(data, `s${s}_count`)
		// Under a mix a stage nobody reached, such as a cart journey in checkout-stress, writes no line.
		if (ordering && count === 0) return
		const statuses = Object.fromEntries(
			[...STATUSES, 'other', 'error']
				.map(code => [code, countIn(data, `s${s}_status_${code}`)])
				.filter(([, n]) => n > 0),
		)
		lines.push({
			...identity,
			event: 'window',
			at: now.toISOString(),
			stage,
			count,
			failures: countIn(data, `s${s}_failures`),
			statuses,
			ttfb: sparse(data, `s${s}_ttfb`),
			total: sparse(data, `s${s}_total`),
		})
	})
	lines.push({ ...identity, event: 'finished', at: now.toISOString(), concurrency: users })
	return { stdout: `${lines.map(line => JSON.stringify(line)).join('\n')}\n` }
}
