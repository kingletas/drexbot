import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { record, type Histogram } from '../src/bee/histogram.js'
import {
	beeLinesIn,
	CHECKOUT_STAGES,
	isJourneyStage,
	JOURNEY_PREFIX,
	type BeeLine,
	type StageWindow,
} from '../src/bee/lines.js'
import { journeyFor, MIXES, type Mix } from '../src/bee/mix.js'
import { planRun, shapeKey, type RunPlan, type Shape } from '../src/swarm/plan.js'
import { reconcile } from '../src/swarm/reconcile.js'
import { renderRecord, RECORD_TAG, type RunRecord } from '../src/swarm/record.js'
import { bytesOf, type BeeHost } from '../src/swarm/settings.js'

const ROOT = join(import.meta.dirname, '..', '..')

/** The part of the k6 bee that repeats the mix, the stage names and the gates, which a test can run. */
interface BeeMix {
	readonly MIXES: Record<string, Mix>
	readonly JOURNEY_PREFIX: string
	readonly REST_STAGES: readonly string[]
	readonly journeyFor: (mix: Mix, roll: number) => string
	readonly mixFrom: (env: Record<string, string | undefined>) => {
		readonly name: string
		readonly mix: Mix
		readonly sku?: string
	}
}

const beeMix = (): BeeMix => {
	const script = readFileSync(join(ROOT, 'bees', 'protocol', 'bee.js'), 'utf8')
	const block = /\/\/ mix: begin[^\n]*\n([\s\S]*?)\/\/ mix: end/.exec(script)?.[1]
	assert.ok(block !== undefined, 'bee.js has no "mix: begin" ... "mix: end" block')
	return runInNewContext(
		`${block}\n({ MIXES, JOURNEY_PREFIX, REST_STAGES, journeyFor, mixFrom })`,
	) as BeeMix
}

describe('the mix the k6 bee carries', () => {
	it('holds every figure equal to src/bee/mix.ts', () => {
		const copy = beeMix().MIXES
		assert.deepEqual(Object.keys(copy).sort(), Object.keys(MIXES).sort())
		for (const [name, mix] of Object.entries(MIXES)) {
			assert.deepEqual({ ...copy[name] }, { ...mix }, `${name} differs from src/bee/mix.ts`)
		}
	})

	it('lands every roll on the journey the browser bee would draw', () => {
		const bee = beeMix()
		for (const [name, mix] of Object.entries(MIXES)) {
			for (let roll = 0; roll < 1; roll += 0.0005) {
				assert.equal(bee.journeyFor(bee.MIXES[name] as Mix, roll), journeyFor(mix, roll), name)
			}
		}
	})

	it('names journeys as the record reads them, and REST steps from the stages it already knows', () => {
		const bee = beeMix()
		assert.equal(bee.JOURNEY_PREFIX, JOURNEY_PREFIX)
		assert.ok(bee.REST_STAGES.length > 0)
		for (const stage of bee.REST_STAGES) {
			assert.ok(CHECKOUT_STAGES.includes(stage), `${stage} is not in CHECKOUT_STAGES`)
		}
		assert.ok(
			bee.REST_STAGES.includes('cart') &&
				bee.REST_STAGES.includes('shipping') &&
				bee.REST_STAGES.includes('place-order'),
			'the steps that match a browser step keep its name',
		)
	})
})

describe('who may place an order from a k6 user', () => {
	const ordering = { BEE_MIX: 'normal-day', BEE_CART_SKU: 'TEST-SKU-1' }

	it('browses when no mix is named, or browse is', () => {
		const bee = beeMix()
		assert.equal(bee.mixFrom({}).name, 'browse')
		assert.equal(bee.mixFrom({ BEE_MIX: 'browse' }).name, 'browse')
		assert.equal(bee.mixFrom({ BEE_MIX: '' }).name, 'browse')
		assert.throws(() => bee.mixFrom({ BEE_MIX: 'black-friday' }), /BEE_MIX must be one of/)
	})

	it('refuses an ordering mix unless BEE_DISPOSABLE is exactly 1', () => {
		const bee = beeMix()
		assert.throws(() => bee.mixFrom(ordering), /places orders, and BEE_DISPOSABLE is not 1/)
		assert.throws(() => bee.mixFrom({ ...ordering, BEE_DISPOSABLE: 'true' }), /BEE_DISPOSABLE/)
		assert.equal(bee.mixFrom({ ...ordering, BEE_DISPOSABLE: '1' }).sku, 'TEST-SKU-1')
	})

	it('refuses a mix that fills carts when it names no SKU', () => {
		const bee = beeMix()
		const env = { BEE_MIX: 'checkout-stress', BEE_DISPOSABLE: '1' }
		assert.throws(() => bee.mixFrom(env), /BEE_CART_SKU names none/)
		assert.throws(() => bee.mixFrom({ ...env, BEE_CART_SKU: '' }), /BEE_CART_SKU names none/)
	})
})

const host: BeeHost = {
	name: 'bees',
	dockerHost: 'ssh://bees.example',
	cpus: 4,
	memory: bytesOf('8g'),
}

const shape = (mix?: Shape['mix'], browserBees = 0): Shape => ({
	browser: { bees: browserBees, workers: 2, cpus: 2, memory: bytesOf('2g') },
	protocol: { bees: 1, users: 50, cpus: 1, memory: bytesOf('1g') },
	seconds: 300,
	...(mix === undefined ? {} : { mix }),
})

const planned = (
	mix: Shape['mix'],
	extra: { cartSku?: string; cartPath?: string; disposable?: boolean; browserBees?: number } = {},
): RunPlan | string =>
	planRun({
		url: 'http://store.example:8080/',
		stages: [{ stage: 'home', path: '/' }],
		host,
		via: 'docker',
		shape: shape(mix, extra.browserBees),
		images: { browser: 'bee-browser:test', protocol: 'bee-protocol:test' },
		run: 'run-1',
		...(extra.cartSku === undefined ? {} : { cartSku: extra.cartSku }),
		...(extra.cartPath === undefined ? {} : { cartPath: extra.cartPath }),
		...(extra.disposable === undefined ? {} : { disposable: extra.disposable }),
	})

const refusalOf = (plan: RunPlan | string): string => (typeof plan === 'string' ? plan : '')

describe('planning protocol bees that order', () => {
	it('refuses unless the store said it may take orders, as it does for browser bees', () => {
		assert.match(
			refusalOf(planned('normal-day', { cartSku: 'TEST-SKU-1' })),
			/places orders.*MAGENTO_DISPOSABLE=1/,
		)
	})

	it('refuses without a SKU, and says what to set', () => {
		const refusal = refusalOf(planned('checkout-stress', { disposable: true }))
		assert.match(refusal, /protocol bees/)
		assert.match(refusal, /SKU/)
		assert.match(refusal, /--sku/)
		assert.match(refusal, /baseline/)
	})

	it('does not ask a protocol-only run for a product page', () => {
		const plan = planned('normal-day', { cartSku: 'TEST-SKU-1', disposable: true })
		assert.equal(refusalOf(plan), '')
	})

	it('still asks browser bees for a product page, SKU or not', () => {
		assert.match(
			refusalOf(planned('normal-day', { cartSku: 'TEST-SKU-1', disposable: true, browserBees: 1 })),
			/names no product to buy/,
		)
	})

	it('hands the protocol bees the mix, the SKU and the permission, and room for a late checkout', () => {
		const plan = planned('normal-day', { cartSku: 'TEST-SKU-1', disposable: true })
		assert.equal(refusalOf(plan), '')
		const env = (plan as RunPlan).bees[0]?.env ?? {}
		assert.equal(env['BEE_MIX'], 'normal-day')
		assert.equal(env['BEE_CART_SKU'], 'TEST-SKU-1')
		assert.equal(env['BEE_DISPOSABLE'], '1')
		assert.equal(env['BEE_LIFETIME'], '480')
	})

	it('gives each kind what it needs when a run has both', () => {
		const plan = planned('checkout-stress', {
			cartSku: 'TEST-SKU-1',
			cartPath: '/bag.html',
			disposable: true,
			browserBees: 1,
		}) as RunPlan
		const [browser, protocol] = plan.bees
		assert.equal(browser?.kind, 'browser')
		assert.equal(browser?.env['BEE_CART_PATH'], '/bag.html')
		assert.equal(protocol?.kind, 'protocol')
		assert.equal(protocol?.env['BEE_CART_SKU'], 'TEST-SKU-1')
		assert.equal(protocol?.env['BEE_DISPOSABLE'], '1')
	})

	it('changes nothing for protocol bees that only browse', () => {
		for (const mix of [undefined, 'browse'] as const) {
			const env = (planned(mix, { cartSku: 'TEST-SKU-1', disposable: true }) as RunPlan).bees[0]
				?.env
			assert.equal(env?.['BEE_CART_SKU'], undefined)
			assert.equal(env?.['BEE_DISPOSABLE'], undefined)
			assert.equal(env?.['BEE_LIFETIME'], '360')
		}
	})
})

const window = (stage: string, totals: number[], failures = 0): BeeLine => {
	const total: Histogram = {}
	for (const value of totals) record(total, value)
	return {
		drexbot: 'bee/1',
		event: 'window',
		run: 'r',
		bee: 'protocol-1',
		kind: 'protocol',
		at: '2026-01-01T00:00:00.000Z',
		stage,
		count: totals.length,
		failures,
		statuses: { '200': totals.length - failures, ...(failures > 0 ? { error: failures } : {}) },
		ttfb: stage === 'home' ? total : {},
		total,
	}
}

const lines: BeeLine[] = [
	window('home', [20, 20, 20, 20]),
	window('cart-create', [30, 30, 30]),
	window('cart', [60, 60, 60], 1),
	window('shipping-estimate', [40, 40]),
	window('shipping', [90, 90]),
	window('place-order', [800, 900], 1),
	window('journey:browse', [200, 200, 200, 200]),
	window('journey:cart', [100]),
	window('journey:order', [1_100, 1_200, 1_300], 2),
]

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
	drexbot: RECORD_TAG,
	run: 'r',
	startedAt: '2026-01-01T00:00:00.000Z',
	finishedAt: '2026-01-01T00:05:00.000Z',
	target: 'http://store.example:8080/',
	host: 'bees',
	via: 'docker',
	shape: shape('checkout-stress'),
	shapeKey: shapeKey(shape('checkout-stress'), 'bees', 'docker'),
	result: reconcile(lines, 300),
	teardown: { removed: 1, leftover: 0, verified: true },
	caveats: [],
	storeCpus: 2,
	...overrides,
})

describe('a run whose orders came from protocol bees', () => {
	it('keeps whole journeys out of every request count', () => {
		const result = reconcile(lines, 300)
		assert.equal(result.protocol?.count, 4 + 3 + 3 + 2 + 2 + 2)
		assert.equal(result.combined.count, 16)
		assert.equal(result.combined.failures, 2)
		assert.equal(result.protocol?.stages['journey:order']?.count, 3)
		assert.equal(result.browser, undefined)
		assert.ok(CHECKOUT_STAGES.every(stage => !isJourneyStage(stage)))
	})

	it('prints the shoppers, each REST step in order, the step that gives first and the orders', () => {
		const text = renderRecord(runRecord())
		assert.match(text, /shoppers, mix checkout-stress: 8 journeys/)
		assert.match(text, /drawn {3}browse 50\.00% {3}cart and leave 12\.50% {3}order 37\.50%/)
		assert.match(text, /served {2}browse 4 of 4 {3}cart and leave 1 of 1 {3}order 1 of 3/)
		assert.match(text, /cart-create {7}p50 \d+ ms {3}p95 \d+ ms {3}0 of 3 failed/)
		assert.match(text, /cart {14}p50 \d+ ms {3}p95 \d+ ms {3}1 of 3 failed/)
		assert.match(text, /shipping-estimate p50/)
		assert.match(text, /gives first: place-order, /)
		assert.match(
			text,
			/orders placed: 1, 0\.10 a minute per store CPU, with the store capped at 2 CPU/,
		)
		assert.doesNotMatch(text, /journey:/)
		assert.ok(
			text.indexOf('cart-create') < text.indexOf('shipping-estimate') &&
				text.indexOf('shipping-estimate') < text.indexOf('place-order'),
		)
	})

	it('lists the pages by their time to first byte and not the checkout steps among them', () => {
		const text = renderRecord(runRecord())
		assert.match(text, /home ttfb/)
		assert.doesNotMatch(text, /cart-create ttfb/)
		assert.doesNotMatch(text, /place-order ttfb/)
	})

	it('names the kind when browser bees drew journeys as well', () => {
		const browserLines: BeeLine[] = lines.map(line => ({
			...line,
			bee: 'browser-1',
			kind: 'browser',
		}))
		const text = renderRecord(runRecord({ result: reconcile([...lines, ...browserLines], 300) }))
		assert.match(text, /shoppers from protocol bees, mix checkout-stress: 8 journeys/)
		assert.match(text, /shoppers from browser bees, mix checkout-stress: 8 journeys/)
	})

	it('prints no shoppers for a run that only browsed', () => {
		const text = renderRecord(
			runRecord({
				shape: shape(),
				result: reconcile([window('home', [20, 20])], 300),
			}),
		)
		assert.doesNotMatch(text, /shoppers/)
	})
})

interface FakeResponse {
	readonly status: number
	readonly body?: string
}

interface Sent {
	readonly method: string
	readonly url: string
	readonly body: unknown
}

/**
 * The k6 bee run in Node, with k6's http module and counters replaced by
 * doubles, so the requests it makes and the lines it writes can be read
 * without k6 or a store.
 */
const runBee = (
	env: Record<string, string>,
	respond: (sent: Sent) => FakeResponse,
	iterations: readonly number[],
) => {
	const script = readFileSync(join(ROOT, 'bees', 'protocol', 'bee.js'), 'utf8')
		.replace(/^import .*$/gm, '')
		.replace('export default function ()', 'function iterate()')
		.replace('export function handleSummary', 'function handleSummary')
		.replace('export const options', 'const options')
	const counts = new Map<string, number>()
	const sent: Sent[] = []
	const answer = (method: string, url: string, body: unknown): unknown => {
		const request: Sent = {
			method,
			url,
			body: typeof body === 'string' ? (JSON.parse(body) as unknown) : body,
		}
		sent.push(request)
		const response = respond(request)
		return { ...response, body: response.body ?? '', timings: { waiting: 5, duration: 12 } }
	}
	// Only the first draw of an iteration is the journey's roll; the rest are for invented addresses.
	let roll = 0
	let drawn = false
	const sandbox = {
		__ENV: {
			BEE_URL: 'http://store.example:8080/',
			BEE_PATHS: JSON.stringify([
				{ stage: 'home', path: '/' },
				{ stage: 'category', path: '/gear.html' },
			]),
			BEE_RUN: 'r',
			BEE_ID: 'protocol-1',
			BEE_CONCURRENCY: '2',
			BEE_SECONDS: '60',
			...env,
		},
		__VU: 1,
		__ITER: 0,
		Math: Object.create(Math, {
			random: {
				value: () => {
					if (drawn) return 0.5
					drawn = true
					return roll
				},
			},
		}) as Math,
		http: {
			get: (url: string) => answer('GET', url, undefined),
			post: (url: string, body: unknown) => answer('POST', url, body ?? undefined),
		},
		Counter: class {
			constructor(private readonly name: string) {}
			add(n: number): void {
				counts.set(this.name, (counts.get(this.name) ?? 0) + n)
			}
		},
	}
	const bee = runInNewContext(`${script}\n({ iterate, handleSummary, options })`, sandbox) as {
		iterate: () => void
		handleSummary: (data: unknown) => { stdout: string }
		options: { scenarios: { bee: { gracefulStop: string } } }
	}
	for (let i = 0; i < iterations.length; i++) {
		sandbox.__ITER = i
		roll = iterations[i] ?? 0
		drawn = false
		bee.iterate()
	}
	const metrics = Object.fromEntries(
		[...counts].map(([name, count]) => [name, { values: { count } }]),
	)
	const written = beeLinesIn(
		bee.handleSummary({ metrics, state: { testRunDurationMs: 1_000 } }).stdout,
	)
	return { sent, lines: written, gracefulStop: bee.options.scenarios.bee.gracefulStop }
}

const REST = 'http://store.example:8080/rest/V1/guest-carts'
const ordering = { BEE_MIX: 'checkout-stress', BEE_CART_SKU: 'TEST-SKU-1', BEE_DISPOSABLE: '1' }

/** A store that serves every step of a guest checkout, with the cart id it hands out. */
const store = (sent: Sent): FakeResponse => {
	if (sent.url === REST) return { status: 200, body: '"abc123"' }
	if (sent.url.endsWith('/items')) return { status: 200, body: '{"item_id":1}' }
	if (sent.url.endsWith('/estimate-shipping-methods')) {
		return {
			status: 200,
			body: JSON.stringify([
				{ carrier_code: 'flatrate', method_code: 'flatrate', available: true },
				{ carrier_code: 'tablerate', method_code: 'bestway', available: true },
			]),
		}
	}
	if (sent.url.endsWith('/shipping-information')) return { status: 200, body: '{}' }
	if (sent.url.endsWith('/payment-information')) return { status: 200, body: '42' }
	return { status: 200 }
}

const stageOf = (lines: readonly BeeLine[], stage: string): StageWindow | undefined =>
	lines.find((line): line is StageWindow => line.event === 'window' && line.stage === stage)

describe('the k6 bee running a checkout, with k6 and the store replaced', () => {
	it('asks for one page per iteration and writes the lines it always has, without a mix', () => {
		const { sent, lines, gracefulStop } = runBee({}, store, [0, 0, 0, 0])
		assert.deepEqual(
			sent.map(request => `${request.method} ${request.url}`),
			[
				'GET http://store.example:8080/gear.html',
				'GET http://store.example:8080/',
				'GET http://store.example:8080/gear.html',
				'GET http://store.example:8080/',
			],
		)
		const windows = lines.flatMap(line => (line.event === 'window' ? [line.stage] : []))
		assert.deepEqual(windows, ['home', 'category'])
		assert.equal(lines[0]?.event === 'started' ? lines[0].note : 'wrong', undefined)
		assert.equal(gracefulStop, '5s')
	})

	it('places an order as a guest by REST, over the first shipping method, paying by Check / Money order', () => {
		const { sent, gracefulStop } = runBee(ordering, store, [0])
		assert.deepEqual(
			sent.map(request => `${request.method} ${request.url.replace(REST, '')}`),
			[
				'POST ',
				'POST /abc123/items',
				'POST /abc123/estimate-shipping-methods',
				'POST /abc123/shipping-information',
				'POST /abc123/payment-information',
			],
		)
		const [, item, , shipping, payment] = sent.map(request => request.body) as Record<
			string,
			Record<string, unknown>
		>[]
		assert.deepEqual(item?.['cartItem'], { sku: 'TEST-SKU-1', qty: 1, quote_id: 'abc123' })
		const information = shipping?.['addressInformation']
		assert.equal(information?.['shipping_carrier_code'], 'flatrate')
		assert.equal(information?.['shipping_method_code'], 'flatrate')
		assert.match(JSON.stringify(information?.['shipping_address']), /@drexbot\.test/)
		assert.deepEqual(payment?.['paymentMethod'], { method: 'checkmo' })
		assert.doesNotMatch(JSON.stringify(sent), /cc_number|cc_cid|braintree|stripe|adyen/i)
		assert.equal(gracefulStop, '60s')
	})

	it('writes each REST step as a stage of its own, and the journey beside them', () => {
		const { lines } = runBee(ordering, store, [0, 0.5, 0.5])
		const stages = lines.flatMap(line => (line.event === 'window' ? [line.stage] : []))
		assert.deepEqual(stages, [
			'home',
			'category',
			'cart-create',
			'cart',
			'shipping-estimate',
			'shipping',
			'place-order',
			'journey:browse',
			'journey:order',
		])
		assert.equal(stageOf(lines, 'place-order')?.count, 1)
		assert.equal(stageOf(lines, 'journey:order')?.count, 1)
		assert.equal(stageOf(lines, 'journey:browse')?.count, 2)
		assert.equal(stageOf(lines, 'home')?.count, 2)
		assert.deepEqual(stageOf(lines, 'place-order')?.statuses, { '200': 1 })
		assert.equal(Object.keys(stageOf(lines, 'cart-create')?.ttfb ?? {}).length, 1)
		const started = lines[0]
		assert.equal(started?.event === 'started' ? started.note : undefined, 'mix checkout-stress')
		for (const stage of stages) {
			assert.ok(
				CHECKOUT_STAGES.includes(stage) ||
					['home', 'category'].includes(stage) ||
					isJourneyStage(stage),
			)
		}
	})

	it('stops a journey at the step the store refused, and says which step it was', () => {
		const refusing = (request: Sent): FakeResponse =>
			request.url.endsWith('/items')
				? { status: 400, body: '{"message":"out of stock"}' }
				: store(request)
		const { sent, lines } = runBee(ordering, refusing, [0])
		assert.equal(sent.length, 2)
		assert.equal(stageOf(lines, 'cart')?.failures, 1)
		assert.deepEqual(stageOf(lines, 'cart')?.statuses, { '400': 1 })
		assert.equal(stageOf(lines, 'shipping-estimate'), undefined)
		const journey = stageOf(lines, 'journey:order')
		assert.equal(journey?.failures, 1)
		assert.deepEqual(journey?.statuses, { error: 1 })
	})

	it('counts a store with no shipping method on offer as the estimate failing', () => {
		const none = (request: Sent): FakeResponse =>
			request.url.endsWith('/estimate-shipping-methods')
				? { status: 200, body: '[]' }
				: store(request)
		const { sent, lines } = runBee(ordering, none, [0])
		assert.equal(sent.length, 3)
		assert.equal(stageOf(lines, 'shipping-estimate')?.failures, 1)
		assert.equal(stageOf(lines, 'shipping'), undefined)
		assert.equal(stageOf(lines, 'journey:order')?.failures, 1)
	})

	it('refuses to start an ordering mix without the permission, before any request', () => {
		assert.throws(
			() => runBee({ ...ordering, BEE_DISPOSABLE: '' }, store, [0]),
			/BEE_DISPOSABLE is not 1/,
		)
	})

	it('writes lines the record reads as a run with orders in it', () => {
		const { lines } = runBee(ordering, store, [0, 0, 0.5, 0.99])
		const result = reconcile(lines, 60)
		// Two orders of five requests each and two browses of two pages; the journeys themselves are not requests.
		assert.equal(result.protocol?.count, 2 * 5 + 2 * 2)
		assert.equal(result.protocol?.stages['journey:order']?.count, 2)
		const text = renderRecord(runRecord({ result }))
		assert.match(text, /orders placed: 2,/)
		assert.match(text, /place-order +p50/)
	})
})
