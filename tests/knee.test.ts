import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
	besideKnee,
	fractionOf,
	kneeRecordOf,
	latestKnee,
	missingKnee,
	renderShare,
	shareOf,
	spread,
	usersAt,
	writeKnee,
	type KneeRecord,
} from '../src/swarm/knee.js'
import { readRecords, renderRecord, RECORD_TAG, type RunRecord } from '../src/swarm/record.js'
import type { StepTaken, Verdict } from '../src/swarm/step.js'

const knee = (
	lastGood: number,
	at = '2026-11-02T03:00:00.000Z',
	extra: Partial<KneeRecord> = {},
): KneeRecord => ({
	drexbot: 'swarm-knee/1',
	id: `knee-${at}`,
	at,
	target: 'http://shop.example:8080',
	mix: 'normal-day',
	seconds: 120,
	lastGood: { users: lastGood, run: 'run-good' },
	firstBad: { users: lastGood + 1, run: 'run-bad' },
	done: `the knee is between ${lastGood} and ${lastGood + 1} users`,
	caps: [
		{ service: 'php', capCpus: 2 },
		{ service: 'db', capCpus: 1 },
	],
	...extra,
})

const step = (users: number, verdict: Verdict): StepTaken => ({
	users,
	checkoutP95: 400,
	p95: 100,
	requests: 1_000,
	failures: 0,
	perSecond: users * 10,
	verdict,
	reason: '',
	run: `run-${users}`,
	seconds: 120,
	ordersPlaced: users,
	capped: [
		{ service: 'php', capCpus: 2, share: 0.9 },
		{ service: 'db', capCpus: 1, share: 0.3 },
	],
	machineLoad: 0.2,
})

const results = (): string => mkdtempSync(join(tmpdir(), 'drexbot-knee-'))

describe('a run set from the knee', () => {
	it('takes the fraction of the last good step, rounding down', () => {
		assert.equal(usersAt(knee(4), 0.5), 2)
		assert.equal(usersAt(knee(5), 0.5), 2)
		assert.equal(usersAt(knee(40), 0.9), 36)
		assert.equal(usersAt(knee(5), 1), 5)
	})

	it('refuses a share under one user rather than round it up', () => {
		assert.match(
			String(usersAt(knee(1), 0.5)),
			/0\.5 of the knee's last good step, 1 users, is under one user/,
		)
	})

	it('refuses a fraction outside 0 to 1, or none at all', () => {
		for (const fraction of [0, -0.5, 1.5, Number.NaN])
			assert.match(
				String(usersAt(knee(10), fraction)),
				/--of-knee is a fraction of the knee, above 0 and at most 1/,
			)
	})

	it('quotes what was typed when it is not a number, never NaN', () => {
		assert.match(String(fractionOf('abc')), /it was given "abc"$/)
		assert.match(String(fractionOf(undefined)), /it was given nothing$/)
		assert.match(String(fractionOf('')), /it was given nothing$/)
		assert.match(String(fractionOf('--url')), /it was given nothing$/)
		assert.equal(fractionOf('0.5'), 0.5)
		for (const typed of ['abc', undefined, ''])
			assert.doesNotMatch(String(fractionOf(typed)), /NaN/)
	})

	it('refuses a rate of orders beside it with a sentence of its own', () => {
		for (const flags of [
			['--orders', '25'],
			['--per', '5m'],
			['--orders', '25', '--per', '5m'],
		])
			assert.match(
				String(besideKnee(['--of-knee', '0.5', ...flags])),
				/--of-knee sets how many shoppers run, and --orders sets how many orders arrive/,
			)
		assert.match(
			String(besideKnee(['--of-knee', '0.5', '--protocol-users', '9'])),
			/--of-knee sets --protocol-users itself/,
		)
		assert.equal(besideKnee(['--of-knee', '0.5', '--url', 'http://shop.example:8080']), undefined)
	})

	it('says how to measure the missing knee at the mix the run asked for', () => {
		assert.match(missingKnee('http://shop.example:8080', 'normal-day'), /--store-project NAME$/)
		assert.match(
			missingKnee('http://shop.example:8080', 'checkout-stress'),
			/drexbot swarm step --url http:\/\/shop\.example:8080 --store-project NAME --mix checkout-stress$/,
		)
	})

	it('spreads users over as few bees as hold them, never more users than asked', () => {
		assert.deepEqual(spread(36, 100), { bees: 1, each: 36 })
		assert.deepEqual(spread(250, 100), { bees: 3, each: 83 })
		assert.deepEqual(spread(151, 100), { bees: 2, each: 75 })
	})
})

describe('the knee on disk', () => {
	it('keeps the bracket, the caps and the store from the steps', () => {
		const record = kneeRecordOf(
			[step(2, 'good'), step(4, 'good'), step(8, 'knee'), step(6, 'knee'), step(5, 'good')],
			'the knee is between 5 and 6 users',
			{ id: 'test-1', target: 'http://shop.example:8080', mix: 'normal-day' },
		)
		assert.deepEqual(record?.lastGood, { users: 5, run: 'run-5' })
		assert.deepEqual(record?.firstBad, { users: 6, run: 'run-6' })
		assert.deepEqual(record?.caps, [
			{ service: 'php', capCpus: 2 },
			{ service: 'db', capCpus: 1 },
		])
	})

	it('has nothing to keep when no step was good', () => {
		assert.equal(
			kneeRecordOf([step(5, 'knee')], 'the first step was already past the knee', {
				id: 'test-2',
				target: 'http://shop.example:8080',
				mix: 'normal-day',
			}),
			undefined,
		)
	})

	it('reads back the newest knee for the store and mix, and none for another', () => {
		const dir = results()
		writeKnee(dir, knee(4, '2026-11-01T03:00:00.000Z'))
		writeKnee(dir, knee(6, '2026-11-02T03:00:00.000Z'))
		writeKnee(dir, knee(9, '2026-11-03T03:00:00.000Z', { mix: 'checkout-stress' }))
		writeKnee(dir, knee(12, '2026-11-04T03:00:00.000Z', { target: 'http://other.example:8080' }))
		assert.equal(latestKnee(dir, 'http://shop.example:8080', 'normal-day')?.lastGood.users, 6)
		assert.equal(latestKnee(dir, 'http://nowhere.example', 'normal-day'), undefined)
		assert.equal(latestKnee(results(), 'http://shop.example:8080', 'normal-day'), undefined)
	})

	it("finds the knee by the store's origin, as swarm-targets does, so a trailing slash still finds it", () => {
		const dir = results()
		writeKnee(dir, knee(6))
		assert.equal(latestKnee(dir, 'http://shop.example:8080/', 'normal-day')?.lastGood.users, 6)
		assert.equal(latestKnee(dir, 'http://shop.example:8081/', 'normal-day'), undefined)
	})

	it('is never read as a run', () => {
		const dir = results()
		writeKnee(dir, knee(4))
		mkdirSync(join(dir, 'swarm'), { recursive: true })
		writeFileSync(join(dir, 'swarm', 'not-a-run.json'), '{}\n')
		assert.deepEqual(readRecords(dir), [])
	})
})

describe('the run says which knee it was set from', () => {
	it('prints the fraction, the knee, when it was measured and its caps', () => {
		const share = shareOf(knee(5), 0.5)
		assert.equal(
			renderShare(share),
			'  load: 0.5 of the knee measured 2026-11-02 03:00 UTC (step test knee-2026-11-02T03:00:00.000Z, last good step 5 users, caps db 1, php 2 CPU)',
		)
		const record: RunRecord = {
			drexbot: RECORD_TAG,
			run: 'run-share',
			startedAt: '2026-11-02T04:00:00.000Z',
			finishedAt: '2026-11-02T04:02:00.000Z',
			target: 'http://shop.example:8080',
			host: 'local',
			via: 'docker',
			shape: {
				browser: { bees: 0, workers: 2, cpus: 2, memory: 1 },
				protocol: { bees: 1, users: 2, cpus: 1, memory: 1 },
				seconds: 120,
			},
			shapeKey: 'protocol 1x2@1cpu',
			result: {
				combined: {
					count: 0,
					failures: 0,
					errorRate: 0,
					ttfb: { p50: undefined, p95: undefined, p99: undefined },
				},
			},
			teardown: { removed: 1, leftover: 0, verified: true },
			caveats: [],
			knee: share,
		}
		assert.match(renderRecord(record), /load: 0\.5 of the knee measured 2026-11-02 03:00 UTC/)
	})
})
