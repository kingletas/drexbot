import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Harness, Options } from 'harness-kernel'
import { swarmCommand } from '../src/cli/commands/swarm.js'
import {
	isNight,
	ordersFor,
	parseNight,
	shopRun,
	type NightWindow,
	type ShopRun,
} from '../src/swarm/shop.js'

/** A local-time clock on an invented day, so the test holds in any time zone. */
const at = (hour: number, minute: number): Date => new Date(2026, 10, 1, hour, minute, 30)

/** A refusal's words, or a marker when the value is not one. */
const why = (result: unknown): string => (typeof result === 'string' ? result : 'not a refusal')

const RATES = { night: 25, day: 5 }

const window = (text: string): NightWindow => {
	const parsed = parseNight(text)
	assert.equal(typeof parsed, 'object', `${text}: ${why(parsed)}`)
	return parsed as NightWindow
}

describe('the night window', () => {
	it('reads HH:MM-HH:MM as minutes since midnight', () => {
		assert.deepEqual(parseNight('01:00-05:30'), { from: 60, to: 330 })
		assert.deepEqual(parseNight('22:00-02:00'), { from: 1_320, to: 120 })
	})

	it('refuses what is not a window, and a window with no time in it', () => {
		for (const text of [
			'',
			'1:00-5:00',
			'01:00',
			'01:00-25:00',
			'01:60-05:00',
			'01:00-05:00-06:00',
		]) {
			assert.match(why(parseNight(text)), /--night is HH:MM-HH:MM/, text)
		}
		assert.match(why(parseNight('03:00-03:00')), /holds no time/)
	})
})

describe('the rate for a time of day', () => {
	it('is the night rate from the window start up to, not including, its end', () => {
		const night = window('01:00-05:00')
		assert.equal(ordersFor(at(0, 59), night, RATES), 5)
		assert.equal(ordersFor(at(1, 0), night, RATES), 25)
		assert.equal(ordersFor(at(4, 59), night, RATES), 25)
		assert.equal(ordersFor(at(5, 0), night, RATES), 5)
	})

	it('holds across midnight for a window that crosses it', () => {
		const night = window('22:00-02:00')
		assert.equal(ordersFor(at(21, 59), night, RATES), 5)
		assert.equal(ordersFor(at(22, 0), night, RATES), 25)
		assert.equal(ordersFor(at(23, 59), night, RATES), 25)
		assert.equal(ordersFor(at(0, 0), night, RATES), 25)
		assert.equal(ordersFor(at(1, 59), night, RATES), 25)
		assert.equal(ordersFor(at(2, 0), night, RATES), 5)
		assert.equal(ordersFor(at(12, 0), night, RATES), 5)
	})

	it('uses the rates it is given, even when the night one is the lower', () => {
		assert.equal(isNight(window('01:00-05:00'), at(13, 15)), false)
		assert.equal(ordersFor(at(2, 0), window('01:00-05:00'), { night: 3, day: 40 }), 3)
	})
})

const shopped = (argv: readonly string[], now: Date): ShopRun => {
	const result = shopRun(argv, now)
	assert.equal(typeof result, 'object', why(result))
	return result as ShopRun
}

describe('the run a slice makes', () => {
	const flags = [
		'--night',
		'01:00-05:00',
		'--url',
		'http://store.example:8080',
		'--env',
		'showcase',
	]

	it('asks the night rate in the default five minutes, paced over the load that leaves room to start and stop', () => {
		const slice = shopped(flags, at(2, 5))
		assert.equal(slice.orders, 25)
		assert.equal(slice.night, true)
		assert.deepEqual(slice.argv, [
			'--url',
			'http://store.example:8080',
			'--env',
			'showcase',
			'--orders',
			'25',
			'--per',
			'240s',
			'--seconds',
			'240',
		])
	})

	it('asks the day rate outside the window, and takes the rates and the slice from its flags', () => {
		assert.equal(shopped(flags, at(14, 0)).orders, 5)
		const custom = shopped(
			[...flags, '--night-orders', '40', '--day-orders', '8', '--per', '10m'],
			at(3, 0),
		)
		assert.deepEqual(custom.argv.slice(-6), ['--orders', '40', '--per', '540s', '--seconds', '540'])
		assert.equal(shopped([...flags, '--day-orders', '8'], at(14, 0)).orders, 8)
	})

	it('passes every other flag through to the run, in order', () => {
		const slice = shopped(
			['--sku', 'SKU-1', ...flags, '--network', 'shop_default', '--forward', '8080=web:80'],
			at(3, 0),
		)
		assert.deepEqual(slice.argv.slice(0, 10), [
			'--sku',
			'SKU-1',
			'--url',
			'http://store.example:8080',
			'--env',
			'showcase',
			'--network',
			'shop_default',
			'--forward',
			'8080=web:80',
		])
	})

	it('is refused without a window, with a bad one, or with a rate it would overwrite', () => {
		assert.match(why(shopRun([], at(3, 0))), /needs --night HH:MM-HH:MM/)
		assert.match(why(shopRun(['--night'], at(3, 0))), /--night needs a value/)
		assert.match(why(shopRun(['--night', 'night'], at(3, 0))), /--night is HH:MM-HH:MM/)
		assert.match(why(shopRun([...flags, '--orders', '9'], at(3, 0))), /drop --orders/)
	})

	it("shortens the load when --seconds is given, still asking the whole slice's orders, and refuses one that leaves no room", () => {
		const slice = shopped([...flags, '--seconds', '180'], at(3, 0))
		assert.equal(slice.seconds, 180)
		assert.deepEqual(slice.argv.slice(-6), ['--orders', '25', '--per', '180s', '--seconds', '180'])
		assert.equal(slice.argv.filter(arg => arg === '--seconds').length, 1)
		for (const seconds of ['241', '300', '9', '0', '200.5', 'long']) {
			assert.match(
				why(shopRun([...flags, '--seconds', seconds], at(3, 0))),
				/--seconds is the load of one slice/,
				seconds,
			)
		}
	})

	it('is refused for a rate or a slice that is not usable', () => {
		assert.match(
			why(shopRun([...flags, '--night-orders', '0'], at(3, 0))),
			/--night-orders needs a whole number/,
		)
		assert.match(
			why(shopRun([...flags, '--day-orders', '2.5'], at(3, 0))),
			/--day-orders needs a whole number/,
		)
		assert.match(why(shopRun([...flags, '--per', 'often'], at(3, 0))), /--per is a duration/)
		assert.match(
			why(shopRun([...flags, '--per', '60s'], at(3, 0))),
			/--per must be at least 70s: each slice keeps 60 seconds to start and remove its bee/,
		)
	})
})

describe('swarm shop', () => {
	it('stops with exit code 2 before any run when it has no window', async () => {
		const errors: string[] = []
		const write = process.stderr.write.bind(process.stderr)
		process.stderr.write = (chunk: string | Uint8Array) => {
			errors.push(String(chunk))
			return true
		}
		try {
			const code = await swarmCommand({} as Harness, {} as Options, [
				'shop',
				'--url',
				'http://store.example',
			])
			assert.equal(code, 2)
			assert.match(errors.join(''), /swarm shop needs --night/)
		} finally {
			process.stderr.write = write
		}
	})
})
