import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Harness, Options } from 'harness-kernel'
import { swarmCommand } from '../src/cli/commands/swarm.js'
import { record, type Histogram } from '../src/bee/histogram.js'
import type { BeeLine } from '../src/bee/lines.js'
import {
	intervalText,
	orderUsers,
	ordersAskedFor,
	ordersFrom,
	parseInterval,
} from '../src/swarm/orders.js'
import { planRun, shapeKey, type RunPlan, type Shape } from '../src/swarm/plan.js'
import { reconcile } from '../src/swarm/reconcile.js'
import { renderRecord, RECORD_TAG, type RunRecord } from '../src/swarm/record.js'
import { bytesOf, type BeeHost } from '../src/swarm/settings.js'

const refusal = (argv: string[]): string => {
	const asked = ordersFrom(argv)
	assert.equal(typeof asked, 'string', `${argv.join(' ')} was not refused`)
	return asked as string
}

describe('the flags that ask for orders at a set rate', () => {
	it('asks for no rate unless --orders or --per is given', () => {
		assert.equal(ordersFrom([]), undefined)
		assert.equal(ordersFrom(['--seconds', '60', '--mix', 'normal-day']), undefined)
	})

	it('reads a count and a duration in seconds, minutes or hours', () => {
		assert.deepEqual(ordersFrom(['--orders', '25', '--per', '5m']), { count: 25, perSeconds: 300 })
		assert.deepEqual(ordersFrom(['--per', '60s', '--orders', '5']), { count: 5, perSeconds: 60 })
		assert.deepEqual(ordersFrom(['--orders', '1', '--per', '1h']), { count: 1, perSeconds: 3600 })
		assert.deepEqual(ordersFrom(['--orders', '3', '--per', '10s']), { count: 3, perSeconds: 10 })
	})

	it('parses only whole numbers of s, m or h', () => {
		assert.equal(parseInterval('90s'), 90)
		assert.equal(parseInterval('2h'), 7200)
		for (const text of ['', '5', 'm', '5 m', '5min', '1.5m', '-5m', '5M', '1h30m', ' 5m']) {
			assert.equal(parseInterval(text), undefined, `"${text}"`)
		}
	})

	it('writes seconds as the largest unit that holds them whole', () => {
		assert.equal(intervalText(300), '5m')
		assert.equal(intervalText(3600), '1h')
		assert.equal(intervalText(7200), '2h')
		assert.equal(intervalText(90), '90s')
		assert.equal(intervalText(10), '10s')
	})

	it('refuses an order count that is not a whole number above 0, and says what to give', () => {
		for (const count of ['0', '-5', '2.5', 'five', '', '1e3', '0x10']) {
			const said = refusal(['--orders', count, '--per', '5m'])
			assert.match(said, /--orders needs a whole number of orders above 0/, count)
			assert.ok(said.includes(`"${count}"`), count)
		}
		assert.match(refusal(['--orders', '--per', '5m']), /--orders needs a whole number.*not "--per"/)
	})

	it('refuses a duration that does not parse', () => {
		for (const per of ['5', 'five minutes', '5 m', '1.5m', '-1m']) {
			assert.match(
				refusal(['--orders', '5', '--per', per]),
				/--per needs a duration such as 60s, 5m or 1h/,
			)
		}
	})

	it('refuses a duration under 10 seconds, and names the least it takes', () => {
		for (const per of ['9s', '1s', '0s', '0m']) {
			assert.match(refusal(['--orders', '5', '--per', per]), /under 10 seconds.*use 10s or more/)
		}
	})

	it('refuses one flag without the other, and names the one to add', () => {
		assert.match(refusal(['--orders', '5']), /--orders needs --per/)
		assert.match(refusal(['--per', '5m']), /--per needs --orders/)
		assert.match(refusal(['--orders']), /--orders needs --per/)
	})

	it('refuses a rate beside a mix or protocol users, which would pace the orders a second way', () => {
		const rate = ['--orders', '5', '--per', '5m']
		assert.match(refusal([...rate, '--mix', 'normal-day']), /cannot be used with --mix/)
		assert.match(refusal([...rate, '--mix', 'browse']), /cannot be used with --mix/)
		assert.match(
			refusal([...rate, '--protocol-users', '20']),
			/cannot be used with --protocol-users/,
		)
	})

	it('counts the orders a run asks for as N times its seconds over the interval, rounded down', () => {
		assert.equal(ordersAskedFor({ count: 25, perSeconds: 300 }, 600), 50)
		assert.equal(ordersAskedFor({ count: 5, perSeconds: 300 }, 3600), 60)
		assert.equal(ordersAskedFor({ count: 5, perSeconds: 300 }, 100), 1)
		assert.equal(ordersAskedFor({ count: 25, perSeconds: 300 }, 61), 5)
		assert.equal(ordersAskedFor({ count: 1, perSeconds: 3600 }, 600), 0)
	})

	it('sizes users from the rate, at least one to start and twice that at most', () => {
		assert.deepEqual(orderUsers({ count: 25, perSeconds: 300 }), { start: 5, most: 10 })
		assert.deepEqual(orderUsers({ count: 5, perSeconds: 300 }), { start: 1, most: 2 })
		assert.deepEqual(orderUsers({ count: 1, perSeconds: 3600 }), { start: 1, most: 2 })
		assert.deepEqual(orderUsers({ count: 7, perSeconds: 45 }), { start: 10, most: 20 })
	})
})

const host: BeeHost = {
	name: 'bees',
	dockerHost: 'ssh://bees.example',
	cpus: 4,
	memory: bytesOf('8g'),
}

const atRate = (overrides: Partial<Shape> = {}): Shape => ({
	browser: { bees: 0, workers: 2, cpus: 2, memory: bytesOf('2g') },
	protocol: { bees: 1, users: 50, cpus: 1, memory: bytesOf('1g') },
	seconds: 600,
	orders: { count: 25, perSeconds: 300 },
	...overrides,
})

const planned = (
	shape: Shape,
	extra: { cartSku?: string; disposable?: boolean } = { cartSku: 'TEST-SKU-1', disposable: true },
): RunPlan | string =>
	planRun({
		url: 'http://store.example:8080/',
		stages: [{ stage: 'home', path: '/' }],
		host,
		via: 'docker',
		shape,
		images: { browser: 'bee-browser:test', protocol: 'bee-protocol:test' },
		run: 'run-1',
		...(extra.cartSku === undefined ? {} : { cartSku: extra.cartSku }),
		...(extra.disposable === undefined ? {} : { disposable: extra.disposable }),
	})

const refusalOf = (plan: RunPlan | string): string => (typeof plan === 'string' ? plan : '')

describe('planning a run at a set rate', () => {
	it('hands the protocol bee the rate, the SKU, the permission and users to match', () => {
		const plan = planned(atRate())
		assert.notEqual(typeof plan, 'string', refusalOf(plan))
		const [bee, ...others] = (plan as RunPlan).bees
		assert.equal(others.length, 0)
		assert.equal(bee?.kind, 'protocol')
		const env = bee?.env ?? {}
		assert.equal(env['BEE_ORDERS'], '25')
		assert.equal(env['BEE_PER_SECONDS'], '300')
		assert.equal(env['BEE_DISPOSABLE'], '1')
		assert.equal(env['BEE_CART_SKU'], 'TEST-SKU-1')
		assert.equal(env['BEE_SECONDS'], '600')
		assert.equal(env['BEE_MIX'], undefined)
		assert.equal(env['BEE_CONCURRENCY'], '10')
		assert.equal(bee?.concurrency, 10)
	})

	it('gives the bee room for an order begun just before the end', () => {
		assert.equal((planned(atRate()) as RunPlan).bees[0]?.env['BEE_LIFETIME'], '780')
	})

	it('keeps the shape on the plan, rate and all', () => {
		assert.deepEqual((planned(atRate()) as RunPlan).shape.orders, { count: 25, perSeconds: 300 })
	})

	it('sets no rate for a run that has none', () => {
		const env = (planned(atRate({ orders: undefined, mix: 'normal-day' })) as RunPlan).bees[0]?.env
		assert.equal(env?.['BEE_ORDERS'], undefined)
		assert.equal(env?.['BEE_PER_SECONDS'], undefined)
		assert.equal(env?.['BEE_MIX'], 'normal-day')
		assert.equal(env?.['BEE_CONCURRENCY'], '50')
	})

	it('refuses unless the store said it may take orders, as every mix that orders does', () => {
		assert.match(
			refusalOf(planned(atRate(), { cartSku: 'TEST-SKU-1' })),
			/--orders places orders.*MAGENTO_DISPOSABLE=1/,
		)
		assert.match(
			refusalOf(planned(atRate(), { cartSku: 'TEST-SKU-1', disposable: false })),
			/MAGENTO_DISPOSABLE=1/,
		)
	})

	it('refuses without a SKU, and says what to set', () => {
		const said = refusalOf(planned(atRate(), { disposable: true }))
		assert.match(said, /--orders/)
		assert.match(said, /SKU/)
		assert.match(said, /--sku/)
		assert.match(said, /baseline/)
	})

	it('refuses browser bees beside it, and says to turn them off', () => {
		const said = refusalOf(
			planned(atRate({ browser: { bees: 1, workers: 2, cpus: 2, memory: bytesOf('2g') } })),
		)
		assert.match(said, /--orders/)
		assert.match(said, /browser bees/)
		assert.match(said, /--browser-bees 0/)
	})

	it('refuses more than one protocol bee, since a rate shared out would drift', () => {
		const said = refusalOf(
			planned(atRate({ protocol: { bees: 2, users: 50, cpus: 1, memory: bytesOf('1g') } })),
		)
		assert.match(said, /--orders/)
		assert.match(said, /exactly one protocol bee, not 2/)
		assert.match(said, /--protocol-bees 1/)
	})

	it('refuses no protocol bee at all, which has nobody to place the orders', () => {
		const said = refusalOf(
			planned(atRate({ protocol: { bees: 0, users: 50, cpus: 1, memory: bytesOf('1g') } })),
		)
		assert.match(said, /exactly one protocol bee, not 0/)
	})

	it('refuses a mix beside it', () => {
		assert.match(refusalOf(planned(atRate({ mix: 'normal-day' }))), /--orders.*--mix/)
	})

	it('refuses a run that is not a whole number of intervals, so asked and started agree, and says the length to give', () => {
		const short = refusalOf(planned(atRate({ seconds: 10, orders: { count: 5, perSeconds: 300 } })))
		assert.match(short, /lasts a whole number of intervals/)
		assert.match(short, /--seconds 10 is not a multiple of 5m, so give --seconds 300/)
		const between = refusalOf(
			planned(atRate({ seconds: 70, orders: { count: 5, perSeconds: 60 } })),
		)
		assert.match(between, /--seconds 70 is not a multiple of 1m, so give --seconds 60/)
	})

	it('still refuses a run under 10 seconds', () => {
		assert.match(refusalOf(planned(atRate({ seconds: 5 }))), /at least 10 seconds/)
	})
})

describe('comparing runs at a set rate', () => {
	const key = (shape: Shape): string => shapeKey(shape, 'bees', 'docker')

	it('tells runs at different rates apart', () => {
		const base = key(atRate())
		assert.match(base, /orders 25 every 5m/)
		assert.notEqual(base, key(atRate({ orders: { count: 5, perSeconds: 300 } })))
		assert.notEqual(base, key(atRate({ orders: { count: 25, perSeconds: 600 } })))
		assert.notEqual(base, key(atRate({ orders: undefined })))
	})

	it('treats the same rate written two ways as one', () => {
		const written = (per: string): string =>
			key(atRate({ orders: ordersFrom(['--orders', '5', '--per', per]) as Shape['orders'] }))
		assert.equal(written('5m'), written('300s'))
	})

	it('leaves the key of a run with no rate as it was', () => {
		assert.doesNotMatch(key(atRate({ orders: undefined })), /orders/)
		assert.equal(
			key(atRate({ orders: undefined })),
			'browser 0x2@2cpu, protocol 1x50@1cpu, 600s, bees/docker',
		)
	})
})

const bee = (event: 'started' | 'finished', dropped?: number): BeeLine => ({
	drexbot: 'bee/1',
	event,
	run: 'r',
	bee: 'protocol-1',
	kind: 'protocol',
	at: '2026-01-01T00:00:00.000Z',
	concurrency: 10,
	...(dropped === undefined ? {} : { dropped }),
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
		ttfb: {},
		total,
	}
}

/** A bee that started 6 orders, of which 1 failed at the last step, with 2 more k6 could not start. */
const orderLines = (dropped: number | undefined): BeeLine[] => [
	bee('started'),
	window('cart-create', [30, 30, 30, 30, 30, 30]),
	window('cart', [60, 60, 60, 60, 60, 60]),
	window('shipping-estimate', [40, 40, 40, 40, 40, 40]),
	window('shipping', [90, 90, 90, 90, 90, 90]),
	window('place-order', [800, 800, 800, 800, 800, 900], 1),
	window('journey:order', [1_100, 1_100, 1_100, 1_100, 1_100, 1_200], 1),
	bee('finished', dropped),
]

const rateRecord = (lines: BeeLine[], overrides: Partial<RunRecord> = {}): RunRecord => {
	const shape = atRate({ seconds: 180 })
	return {
		drexbot: RECORD_TAG,
		run: 'r',
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:03:00.000Z',
		target: 'http://store.example:8080/',
		host: 'bees',
		via: 'docker',
		shape,
		shapeKey: shapeKey(shape, 'bees', 'docker'),
		result: reconcile(lines, 180),
		teardown: { removed: 1, leftover: 0, verified: true },
		caveats: [],
		...overrides,
	}
}

describe('a run at a set rate in the record', () => {
	it('adds dropped orders over the bees that said so, and says nothing for bees that did not', () => {
		assert.equal(reconcile(orderLines(2), 180).protocol?.dropped, 2)
		assert.equal(reconcile(orderLines(0), 180).protocol?.dropped, 0)
		assert.equal(reconcile(orderLines(undefined), 180).protocol?.dropped, undefined)
		const second = orderLines(3).map(line => ({ ...line, bee: 'protocol-2' }))
		assert.equal(reconcile([...orderLines(2), ...second], 180).protocol?.dropped, 5)
	})

	it('prints one line: asked for, started, placed, failed and dropped', () => {
		const text = renderRecord(rateRecord(orderLines(2)))
		const printed = text.split('\n').filter(line => /orders at/.test(line))
		assert.deepEqual(printed, [
			'  orders at 25 every 5m: asked for 15, started 6, placed 5, failed 1, dropped 2',
		])
	})

	it('shows no dropped orders as none, not as unknown', () => {
		assert.match(renderRecord(rateRecord(orderLines(0))), /failed 1, dropped 0\n/)
	})

	it('says dropped is not known when the bee stopped before it wrote its last line', () => {
		const stopped = orderLines(undefined).filter(line => line.event !== 'finished')
		assert.match(
			renderRecord(rateRecord(stopped)),
			/failed 1, dropped not known \(the bee stopped early\)\n/,
		)
	})

	it('shows asked for beside a store that took none, so a quiet store is not a small ask', () => {
		const text = renderRecord(rateRecord([bee('started'), bee('finished', 15)]))
		assert.match(
			text,
			/orders at 25 every 5m: asked for 15, started 0, placed 0, failed 0, dropped 15\n/,
		)
	})

	it('rounds the orders asked for down', () => {
		const shape = atRate({ seconds: 61 })
		const text = renderRecord(rateRecord(orderLines(0), { shape }))
		assert.match(text, /asked for 5,/)
	})

	it('prints the line for no other run', () => {
		const shape = atRate({ orders: undefined, mix: 'checkout-stress' })
		const text = renderRecord(rateRecord(orderLines(0), { shape }))
		assert.doesNotMatch(text, /orders at/)
	})
})

describe('swarm run asked for orders it must refuse', () => {
	/** `swarm run` as far as it gets with standard error held; a flag refusal comes before the store, the baseline or Docker. */
	const runWith = async (argv: readonly string[]): Promise<{ code: number; errors: string }> => {
		const errors: string[] = []
		const write = process.stderr.write.bind(process.stderr)
		process.stderr.write = (chunk: string | Uint8Array) => {
			errors.push(String(chunk))
			return true
		}
		try {
			const code = await swarmCommand({} as Harness, {} as Options, ['run', ...argv])
			return { code, errors: errors.join('') }
		} finally {
			process.stderr.write = write
		}
	}

	it('stops with exit code 2 and the sentence that says what to change', async () => {
		for (const [argv, said] of [
			[['--orders', '5'], /--orders needs --per/],
			[['--per', '5m'], /--per needs --orders/],
			[['--orders', '0', '--per', '5m'], /whole number of orders above 0/],
			[['--orders', '5', '--per', '5 minutes'], /duration such as 60s, 5m or 1h/],
			[['--orders', '5', '--per', '9s'], /under 10 seconds/],
			[['--orders', '5', '--per', '5m', '--mix', 'normal-day'], /cannot be used with --mix/],
			[['--orders', '5', '--per', '5m', '--protocol-users', '9'], /--protocol-users/],
		] as const) {
			const { code, errors } = await runWith(argv)
			assert.equal(code, 2, argv.join(' '))
			assert.match(errors, said, argv.join(' '))
			assert.ok(errors.startsWith('drexbot swarm: '), errors)
		}
	})
})
