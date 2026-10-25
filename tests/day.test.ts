import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Harness, Options } from 'harness-kernel'
import { swarmCommand } from '../src/cli/commands/swarm.js'
import { dayPath, dayReport, ordersAsked, renderDay, type DayReport } from '../src/swarm/day.js'
import { parseLedger } from '../src/swarm/deploys.js'
import { shapeKey, type Shape } from '../src/swarm/plan.js'
import type { StageResult } from '../src/swarm/reconcile.js'
import { RECORD_TAG, writeRecord, type RunRecord } from '../src/swarm/record.js'

/** Local times on an invented day, so the bands hold in any time zone. */
const DATE = '2026-11-01'
const at = (hour: number, minute: number, day = 1): Date => new Date(2026, 10, day, hour, minute)
const stamp = (when: Date): string => `${when.toISOString().slice(0, 19)}Z`

const STORE = 'http://store.example:8080'
const OTHER_STORE = 'http://other.example:8080'
const RELEASE = '20261101_0210000001_showcase'
const SECOND_RELEASE = '20261101_1400000002_showcase'
const OPEN_RELEASE = '20261101_2000000003_showcase'

const entry = (when: Date, event: string, release: string, extra: object = {}): string =>
	JSON.stringify({
		env_name: 'showcase',
		event,
		recorded_at: stamp(when),
		release,
		schema: 1,
		...extra,
	})

/** One deploy from 02:10 to 02:16 local, and the day before's, which is not this day's. */
const DEPLOY = [
	entry(at(2, 10, 0), 'deploy.started', '20261031_0210000009_showcase'),
	entry(at(2, 14, 0), 'deploy.finished', '20261031_0210000009_showcase', { outcome: 'success' }),
	entry(at(2, 10), 'deploy.started', RELEASE),
	entry(at(2, 11), 'maintenance.enabled', RELEASE),
	entry(at(2, 12), 'maintenance.disabled', RELEASE),
	entry(at(2, 16), 'deploy.finished', RELEASE, { outcome: 'success' }),
].join('\n')

const SHAPE: Shape = {
	browser: { bees: 0, workers: 2, cpus: 2, memory: 2 },
	protocol: { bees: 1, users: 5, cpus: 1, memory: 1 },
	seconds: 300,
	mix: 'normal-day',
}

const NO_PERCENTILES = { p50: undefined, p95: undefined, p99: undefined }

const stage = (count: number, failures: number, p95?: number): StageResult => ({
	count,
	failures,
	statuses: {},
	ttfb: { p50: p95, p95, p99: p95 },
	total: { p50: p95, p95, p99: p95 },
})

interface Made {
	readonly target?: string
	readonly asked?: number
	readonly placed?: number
	readonly failures?: number
	readonly checkoutP95?: number
	readonly seconds?: number
}

/** A five-minute run from `start` to `end`, with the orders it placed and the checkout it saw. */
const made = (start: Date, end: Date, over: Made = {}): RunRecord => {
	const shape: Shape = {
		...SHAPE,
		...(over.asked === undefined ? {} : { orders: { count: over.asked, perSeconds: 300 } }),
	}
	return {
		drexbot: RECORD_TAG,
		run: `${stamp(start).replace(/[-:]/g, '')}-${over.target === OTHER_STORE ? 'b' : 'a'}`,
		startedAt: start.toISOString(),
		finishedAt: end.toISOString(),
		target: over.target ?? STORE,
		host: 'local',
		via: 'docker',
		shape,
		shapeKey: shapeKey(shape, 'local', 'docker'),
		result: {
			protocol: {
				bees: 1,
				finished: 1,
				count: 100,
				failures: over.failures ?? 0,
				perSecond: 0.3,
				ttfb: NO_PERCENTILES,
				stages: {
					'place-order': stage(over.placed ?? 0, 0, over.checkoutP95),
					...(over.checkoutP95 === undefined ? {} : { checkout: stage(1, 0, over.checkoutP95) }),
				},
			},
			combined: {
				count: 100,
				failures: over.failures ?? 0,
				errorRate: (over.failures ?? 0) / 100,
				ttfb: NO_PERCENTILES,
			},
		},
		teardown: { removed: 1, leftover: 0, verified: true },
		caveats: [],
	}
}

/** The day's runs: one in each place against the 02:10 to 02:16 deploy, and others that are not on the day. */
const RUNS = [
	made(at(23, 58, 0), at(0, 3), { asked: 25, placed: 25 }),
	made(at(23, 58), at(0, 3, 2), { asked: 25, placed: 25 }),
	made(at(2, 0), at(2, 5), { asked: 25, placed: 25, checkoutP95: 400 }),
	made(at(2, 5), at(2, 10), { asked: 25, placed: 24, failures: 1, checkoutP95: 450 }),
	made(at(2, 8), at(2, 13), { asked: 25, placed: 10, failures: 30, checkoutP95: 4_000 }),
	made(at(2, 13), at(2, 18), { asked: 25, placed: 20, failures: 5, checkoutP95: 900 }),
	made(at(2, 14), at(2, 19), { asked: 25, placed: 25, checkoutP95: 420 }),
	made(at(12, 0), at(12, 5), { asked: 5, placed: 5, checkoutP95: 380 }),
	made(at(2, 0), at(2, 5), { target: OTHER_STORE, asked: 25, placed: 25, checkoutP95: 500 }),
]

/** A refusal's words, or a marker when the value is not one. */
const why = (result: unknown): string => (typeof result === 'string' ? result : 'not a refusal')

const reportFor = (ledger: string, url?: string): DayReport => {
	const report = dayReport(DATE, RUNS, parseLedger(ledger, 'ledger.jsonl'), 'ledger.jsonl', url)
	assert.equal(typeof report, 'object', why(report))
	return report as DayReport
}

describe('the runs of a day with one deploy', () => {
	const store = reportFor(DEPLOY, STORE).stores[0]
	const bands = store?.deploys[0]?.bands

	it('keeps the runs that started on the day, in local time, for the store asked about', () => {
		assert.equal(reportFor(DEPLOY, STORE).stores.length, 1)
		assert.equal(store?.target, STORE)
		assert.equal(store?.runs, 7)
		assert.equal(reportFor(DEPLOY, `${STORE}/`).stores[0]?.runs, 7)
	})

	it('names the deploy of the day and not the day before', () => {
		assert.equal(reportFor(DEPLOY).deploys, 1)
		assert.equal(store?.deploys.length, 1)
		assert.equal(store?.deploys[0]?.release, RELEASE)
		assert.equal(store?.wholeDay, undefined)
	})

	it('places a run that overlaps the deploy during it, whichever end it overlaps, and counts the far ones in no band', () => {
		assert.deepEqual(
			bands?.map(band => [band.band, band.runs]),
			[
				['before', 2],
				['during', 3],
				['after', 0],
			],
		)
		// The 12:00 run and the one at the day's end are hours after the deploy, past its two hours either side.
		assert.equal(store?.deploys[0]?.outside, 2)
	})

	it('puts a run that ended as the deploy began before it, and one that began as it ended after it', () => {
		const touching = [
			made(at(2, 5), at(2, 10), { asked: 25, placed: 1 }),
			made(at(2, 16), at(2, 21), { asked: 25, placed: 2 }),
		]
		const report = dayReport(DATE, touching, parseLedger(DEPLOY, 'l'), 'l') as DayReport
		const [before, during, after] = report.stores[0]?.deploys[0]?.bands ?? []
		assert.deepEqual([before?.runs, during?.runs, after?.runs], [1, 0, 1])
	})

	it('adds the orders asked and placed, the failures, and the highest checkout p95 of each band', () => {
		assert.deepEqual(bands?.[0], {
			band: 'before',
			runs: 2,
			asked: 50,
			askedRuns: 2,
			placed: 49,
			failures: 1,
			highestCheckoutP95: 450,
		})
		assert.deepEqual(bands?.[1], {
			band: 'during',
			runs: 3,
			asked: 75,
			askedRuns: 3,
			placed: 55,
			failures: 35,
			highestCheckoutP95: 4_000,
		})
	})

	it('reads each store apart when none is named', () => {
		const stores = reportFor(DEPLOY).stores
		assert.deepEqual(
			stores.map(each => [each.target, each.runs]),
			[
				[OTHER_STORE, 1],
				[STORE, 7],
			],
		)
	})
})

describe('the runs of a day with no deploy', () => {
	it('is one band for the whole day, and says so', () => {
		const report = reportFor(entry(at(2, 10, 0), 'deploy.started', RELEASE), STORE)
		const store = report.stores[0]
		assert.equal(report.deploys, 0)
		assert.deepEqual(store?.deploys, [])
		assert.equal(store?.wholeDay?.band, 'whole day')
		assert.equal(store?.wholeDay?.runs, 7)
		assert.equal(store?.wholeDay?.placed, 134)
		assert.match(renderDay(report), /no deploy that day, so the whole day is one band/)
	})
})

describe('a deploy the ledger never closes', () => {
	it('lasts to the end of the day, so a later run is during it', () => {
		const ledger = entry(at(2, 10), 'deploy.started', OPEN_RELEASE)
		const report = reportFor(ledger, STORE)
		const bands = report.stores[0]?.deploys[0]?.bands
		assert.deepEqual(
			bands?.map(band => band.runs),
			[2, 5, 0],
		)
		assert.match(renderDay(report), /no end recorded, so taken as the end of the day/)
	})
})

describe('a day with two deploys', () => {
	it('places every run against each deploy in turn', () => {
		const ledger = [
			DEPLOY,
			entry(at(11, 58), 'deploy.started', SECOND_RELEASE),
			entry(at(12, 3), 'deploy.finished', SECOND_RELEASE, { outcome: 'success' }),
		].join('\n')
		const deploys = reportFor(ledger, STORE).stores[0]?.deploys
		assert.deepEqual(
			deploys?.map(deploy => deploy.bands.map(band => band.runs)),
			[
				[2, 3, 0],
				[0, 1, 0],
			],
		)
	})
})

describe('orders asked', () => {
	it('is the rate times the length over the interval, rounded down', () => {
		assert.equal(ordersAsked(made(at(2, 0), at(2, 5), { asked: 25 })), 25)
		const sixty = made(at(2, 0), at(2, 5), { asked: 25 })
		const shorter = { ...sixty, shape: { ...sixty.shape, seconds: 100 } }
		assert.equal(ordersAsked(shorter), 8)
	})

	it('is shown as - when a record has no shape.orders', () => {
		const plain = [
			made(at(2, 0), at(2, 5), { placed: 3 }),
			made(at(2, 20), at(2, 25), { placed: 4 }),
		]
		assert.equal(ordersAsked(plain[0] as RunRecord), undefined)
		const report = dayReport(DATE, plain, parseLedger(DEPLOY, 'l'), 'l') as DayReport
		const band = report.stores[0]?.deploys[0]?.bands[0]
		assert.equal(band?.asked, null)
		assert.equal(band?.placed, 3)
		assert.match(renderDay(report), /before\s+1\s+-\s+3\s/)
	})

	it('says how many runs say when only some of a band do', () => {
		const mixed = [made(at(2, 0), at(2, 5), { asked: 25 }), made(at(2, 5), at(2, 9), {})]
		const report = dayReport(DATE, mixed, parseLedger(DEPLOY, 'l'), 'l') as DayReport
		assert.equal(report.stores[0]?.deploys[0]?.bands[0]?.asked, 25)
		assert.match(renderDay(report), /25 \(1 of 2 runs say\)/)
	})
})

describe('the printed day', () => {
	it('labels the checkout p95 as the highest of the runs', () => {
		const printed = renderDay(reportFor(DEPLOY, STORE))
		assert.match(printed, /checkout p95, highest run's/)
		assert.match(printed, /during\s+3\s+75\s+55\s+35\s+4000 ms/)
		assert.match(printed, new RegExp(`deploy ${RELEASE} on showcase: success`))
	})

	it('says so when no run started that day', () => {
		const report = dayReport('2026-12-25', RUNS, parseLedger(DEPLOY, 'l'), 'l') as DayReport
		assert.match(renderDay(report), /no run started that day/)
	})

	it('refuses what is not a date', () => {
		for (const date of ['today', '2026-13-01', '2026-02-30', '2026-1-1']) {
			assert.match(why(dayReport(date, [], [], 'l')), /is not a date like 2026-11-01/, date)
		}
	})
})

describe('swarm day', () => {
	const results = mkdtempSync(join(tmpdir(), 'drexbot-day-'))
	const harness = { workspace: { results, root: results } } as unknown as Harness
	for (const record of RUNS) writeRecord(results, record)
	const ledger = join(results, 'showcase.audit.jsonl')
	writeFileSync(ledger, `${DEPLOY}\n`)

	/** The command with both output streams held. */
	const swarmDay = async (
		argv: readonly string[],
		options: Options = {} as Options,
	): Promise<{ code: number; out: string; errors: string }> => {
		const out: string[] = []
		const errors: string[] = []
		const writeOut = process.stdout.write.bind(process.stdout)
		const writeErr = process.stderr.write.bind(process.stderr)
		process.stdout.write = (chunk: string | Uint8Array) => (out.push(String(chunk)), true)
		process.stderr.write = (chunk: string | Uint8Array) => (errors.push(String(chunk)), true)
		try {
			const code = await swarmCommand(harness, options, ['day', ...argv])
			return { code, out: out.join(''), errors: errors.join('') }
		} finally {
			process.stdout.write = writeOut
			process.stderr.write = writeErr
		}
	}

	it('prints the bands and writes the same report as JSON beside the run records', async () => {
		const { code, out } = await swarmDay([DATE, '--deploy-ledger', ledger], {
			url: STORE,
		} as Options)
		assert.equal(code, 0)
		assert.match(out, /during\s+3\s+75\s+55\s+35\s+4000 ms/)
		const path = dayPath(results, DATE)
		assert.equal(path, join(results, 'swarm', 'day', `${DATE}.json`))
		const written = JSON.parse(readFileSync(path, 'utf8')) as DayReport
		assert.equal(written.date, DATE)
		assert.equal(written.stores[0]?.deploys[0]?.bands[1]?.highestCheckoutP95, 4_000)
	})

	it('refuses a ledger line it cannot read, and a missing ledger or date, with exit code 2', async () => {
		const broken = join(results, 'broken.jsonl')
		writeFileSync(broken, `${DEPLOY}\n{broken\n`)
		const refused = await swarmDay([DATE, '--deploy-ledger', broken])
		assert.equal(refused.code, 2)
		assert.match(refused.errors, /broken\.jsonl, line 7: not JSON/)
		assert.equal((await swarmDay([DATE])).code, 2)
		assert.equal((await swarmDay(['--deploy-ledger', ledger])).code, 2)
		assert.equal((await swarmDay(['yesterday', '--deploy-ledger', ledger])).code, 2)
	})

	it('writes nothing and exits 1 for a day with no run', async () => {
		const { code } = await swarmDay(['2026-12-25', '--deploy-ledger', ledger])
		assert.equal(code, 1)
		assert.equal(existsSync(dayPath(results, '2026-12-25')), false)
	})
})

describe('before and after a deploy, read like with like', () => {
	// A night window of 25 orders a slice from 01:00 to 05:00, a clean deploy at 03:00, and the day's trickle
	// of 5 a slice from 05:00 to midnight: before and after must be two night hours each, and read the same.
	// 2 November, because the fixtures' 1 November is the night the clocks go back an hour.
	const NIGHT = '2026-11-02'
	const on = (hour: number, minute: number): Date => at(hour, minute, 2)
	const NIGHT_RELEASE = '20261101_0300000004_showcase'
	const clean = [
		entry(on(3, 0), 'deploy.started', NIGHT_RELEASE),
		entry(on(3, 6), 'deploy.finished', NIGHT_RELEASE, { outcome: 'success' }),
	].join('\n')
	const slices: RunRecord[] = []
	for (let minute = 60; minute < 24 * 60; minute += 5) {
		const start = on(Math.floor(minute / 60), minute % 60)
		const end = new Date(start.getTime() + 4 * 60_000)
		const night = minute < 5 * 60
		slices.push(
			made(start, end, {
				asked: night ? 25 : 5,
				placed: night ? 25 : 5,
				failures: 1,
				checkoutP95: 400,
			}),
		)
	}

	it('gives before and after the same span, so a clean deploy does not read worse after', () => {
		const report = dayReport(NIGHT, slices, parseLedger(clean, 'l'), 'l', STORE) as DayReport
		const [before, , after] = report.stores[0]?.deploys[0]?.bands ?? []
		// Before is 01:00 to 03:00; after is 03:06 to 05:06, which takes in the 05:00 slice at the day rate.
		assert.equal(before?.runs, 24)
		assert.equal(after?.runs, 23)
		assert.equal(before?.asked, 24 * 25)
		assert.equal(after?.asked, 22 * 25 + 5)
		// Per run the two read the same: the long day of trickle after the night is in no band.
		assert.equal(before?.failures, 24)
		assert.equal(after?.failures, 23)
		assert.equal(before?.highestCheckoutP95, after?.highestCheckoutP95)
		assert.ok((report.stores[0]?.deploys[0]?.outside ?? 0) > 200)
		assert.match(renderDay(report), /before and after are each the 2h either side of a deploy/)
	})

	it('reaches as far as --around says', () => {
		const report = dayReport(
			NIGHT,
			slices,
			parseLedger(clean, 'l'),
			'l',
			STORE,
			30 * 60,
		) as DayReport
		const [before, , after] = report.stores[0]?.deploys[0]?.bands ?? []
		assert.equal(before?.runs, 6)
		assert.equal(after?.runs, 5)
		assert.match(renderDay(report), /each the 30m either side/)
	})
})
