import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BEE_SELECTORS } from '../src/bee/checkout.js'
import { readBeeConfig } from '../src/bee/config.js'
import { record, type Histogram } from '../src/bee/histogram.js'
import type { BeeLine } from '../src/bee/lines.js'
import { CART_ABANDONMENT, journeyFor, MIXES, NORMAL_DAY_ORDER } from '../src/bee/mix.js'
import { LUMA_PROFILE } from '../src/magento/selectors.js'
import { planRun, shapeKey, type RunPlan, type Shape } from '../src/swarm/plan.js'
import { reconcile } from '../src/swarm/reconcile.js'
import { renderRecord, RECORD_TAG, type RunRecord } from '../src/swarm/record.js'
import { bytesOf, type BeeHost } from '../src/swarm/settings.js'

const host: BeeHost = {
	name: 'bees',
	dockerHost: 'ssh://bees.example',
	cpus: 4,
	memory: bytesOf('8g'),
}

const shape = (mix?: Shape['mix'], browserBees = 1): Shape => ({
	browser: { bees: browserBees, workers: 2, cpus: 2, memory: bytesOf('2g') },
	// A run without browser bees still needs a bee, or it is refused for that first.
	protocol: { bees: browserBees === 0 ? 1 : 0, users: 50, cpus: 1, memory: bytesOf('1g') },
	seconds: 300,
	...(mix === undefined ? {} : { mix }),
})

const planned = (
	mix: Shape['mix'],
	extra: { cartPath?: string; disposable?: boolean; browserBees?: number } = {},
): RunPlan | string =>
	planRun({
		url: 'http://store.example:8080/',
		stages: [{ stage: 'home', path: '/' }],
		host,
		via: 'docker',
		shape: shape(mix, extra.browserBees),
		images: { browser: 'bee-browser:test', protocol: 'bee-protocol:test' },
		run: 'run-1',
		...(extra.cartPath === undefined ? {} : { cartPath: extra.cartPath }),
		...(extra.disposable === undefined ? {} : { disposable: extra.disposable }),
	})

/** A plan's refusal, or an empty string when it planned. */
const refusalOf = (plan: RunPlan | string): string => (typeof plan === 'string' ? plan : '')

const envOf = (plan: RunPlan | string): Readonly<Record<string, string>> => {
	assert.equal(refusalOf(plan), '')
	return (plan as RunPlan).bees[0]?.env ?? {}
}

describe('the mix of shoppers', () => {
	it('builds a normal day from the two cited figures, and adds up to every shopper', () => {
		const day = MIXES['normal-day']
		assert.equal(day.order, 0.0162)
		assert.equal(NORMAL_DAY_ORDER, 0.0162)
		assert.equal(CART_ABANDONMENT, 0.7022)
		// Of the shoppers who fill a cart, 70.22% leave it.
		assert.ok(Math.abs(day.cart / (day.cart + day.order) - 0.7022) < 1e-9)
		for (const mix of Object.values(MIXES)) {
			assert.ok(Math.abs(mix.browse + mix.cart + mix.order - 1) < 1e-9)
		}
		assert.equal(MIXES['checkout-stress'].order, 0.4)
	})

	it('lands a roll on orders first, then carts, then browsing', () => {
		const day = MIXES['normal-day']
		assert.equal(journeyFor(day, 0), 'order')
		assert.equal(journeyFor(day, 0.0161), 'order')
		assert.equal(journeyFor(day, 0.0162), 'cart')
		assert.equal(journeyFor(day, 0.054), 'cart')
		assert.equal(journeyFor(day, 0.055), 'browse')
		assert.equal(journeyFor(MIXES.browse, 0), 'browse')
	})
})

describe('who may place an order', () => {
	const env = {
		BEE_PATHS: '[{"stage":"home","path":"/"}]',
		BEE_RUN: 'r',
		BEE_ID: 'b',
		BEE_URL: 'http://localhost:8080/',
		BEE_CONCURRENCY: '2',
		BEE_SECONDS: '30',
	}

	it('browses when no mix is named, as a bee always has', () => {
		assert.equal(readBeeConfig(env).mix, 'browse')
		assert.throws(
			() => readBeeConfig({ ...env, BEE_MIX: 'black-friday' }),
			/BEE_MIX must be one of/,
		)
	})

	it('refuses an ordering mix in the bee itself unless BEE_DISPOSABLE is exactly 1', () => {
		const ordering = { ...env, BEE_MIX: 'normal-day', BEE_CART_PATH: '/bag.html' }
		assert.throws(() => readBeeConfig(ordering), /places orders, and BEE_DISPOSABLE is not 1/)
		assert.throws(() => readBeeConfig({ ...ordering, BEE_DISPOSABLE: 'true' }), /BEE_DISPOSABLE/)
		assert.throws(
			() => readBeeConfig({ ...ordering, BEE_CART_PATH: '', BEE_DISPOSABLE: '1' }),
			/BEE_CART_PATH names none/,
		)
		assert.equal(readBeeConfig({ ...ordering, BEE_DISPOSABLE: '1' }).cartPath, '/bag.html')
	})

	it('refuses to plan an ordering mix unless the store said it may take orders', () => {
		assert.match(
			refusalOf(planned('normal-day', { cartPath: '/bag.html' })),
			/places orders.*MAGENTO_DISPOSABLE=1/,
		)
		assert.match(
			refusalOf(planned('checkout-stress', { disposable: true })),
			/names no product to buy/,
		)
		assert.match(
			refusalOf(planned('normal-day', { cartPath: '/bag.html', disposable: true, browserBees: 0 })),
			/walked by browser bees, and this run has none/,
		)
	})

	it('hands the bees the mix, the product and the permission, and room for a late checkout', () => {
		const env = envOf(planned('normal-day', { cartPath: '/bag.html', disposable: true }))
		assert.equal(env['BEE_MIX'], 'normal-day')
		assert.equal(env['BEE_CART_PATH'], '/bag.html')
		assert.equal(env['BEE_DISPOSABLE'], '1')
		assert.equal(env['BEE_LIFETIME'], '480')
	})

	it('changes nothing for a run that only browses', () => {
		const env = envOf(planned(undefined, { cartPath: '/bag.html', disposable: true }))
		assert.equal(env['BEE_MIX'], undefined)
		assert.equal(env['BEE_CART_PATH'], undefined)
		assert.equal(env['BEE_DISPOSABLE'], undefined)
		assert.equal(env['BEE_LIFETIME'], '360')
		assert.equal(shapeKey(shape(), 'bees', 'docker'), shapeKey(shape('browse'), 'bees', 'docker'))
		assert.notEqual(
			shapeKey(shape(), 'bees', 'docker'),
			shapeKey(shape('normal-day'), 'bees', 'docker'),
		)
	})
})

const window = (stage: string, totals: number[], failures = 0): BeeLine => {
	const total: Histogram = {}
	for (const value of totals) record(total, value)
	return {
		drexbot: 'bee/1',
		event: 'window',
		run: 'r',
		bee: 'browser-1',
		kind: 'browser',
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
	window('home', [100, 100, 100, 100]),
	window('cart', [300, 300]),
	window('checkout', [900, 900]),
	window('shipping', [2_000, 4_000]),
	window('place-order', [1_500], 1),
	window('confirmation', [400]),
	window('journey:browse', [5_000, 5_000, 5_000, 5_000, 5_000, 5_000]),
	window('journey:cart', [3_000]),
	window('journey:order', [9_000, 9_000, 9_000], 2),
]

describe('a run with checkouts in it', () => {
	it('keeps whole journeys out of every request count', () => {
		const result = reconcile(lines, 300)
		assert.equal(result.browser?.count, 12)
		assert.equal(result.combined.count, 12)
		assert.equal(result.combined.failures, 1)
		assert.equal(result.browser?.stages['journey:order']?.count, 3)
	})

	it('reports the mix set and drawn, each step, the step that gives first, and orders per store CPU', () => {
		const run: RunRecord = {
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
		}
		const text = renderRecord(run)
		assert.match(text, /shoppers, mix checkout-stress: 10 journeys/)
		assert.match(text, /set {5}browse 60\.00% {3}cart and leave 0\.00% {3}order 40\.00%/)
		assert.match(text, /drawn {3}browse 60\.00% {3}cart and leave 10\.00% {3}order 30\.00%/)
		assert.match(text, /served {2}browse 6 of 6 {3}cart and leave 1 of 1 {3}order 1 of 3/)
		assert.match(text, /shipping {7}p50 \d+ ms {3}p95 \d+ ms {3}0 of 2 failed/)
		assert.match(text, /gives first: shipping, /)
		assert.match(
			text,
			/orders placed: 1, 0\.10 a minute per store CPU, with the store capped at 2 CPU/,
		)
		assert.doesNotMatch(text, /journey:/)
		assert.match(
			renderRecord({ ...run, storeCpus: undefined }),
			/orders placed: 1; give --store-cpus to read them per store CPU/,
		)
	})
})

describe('the checkout selectors the bee carries', () => {
	it('copies each one from the Luma profile, so the two cannot drift apart unseen', () => {
		for (const [entry, selector] of Object.entries(BEE_SELECTORS)) {
			const candidates = (LUMA_PROFILE as Record<string, readonly string[]>)[entry]
			assert.ok(candidates?.includes(selector), `${entry}: "${selector}" is not in LUMA_PROFILE`)
		}
	})
})
