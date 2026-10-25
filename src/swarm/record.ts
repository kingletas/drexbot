import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKOUT_STAGES, JOURNEY_PREFIX, isJourneyStage, type BeeKind } from '../bee/lines.js'
import { MIXES, type Journey } from '../bee/mix.js'
import { renderDeploys, type DeployReport } from './deploys.js'
import { renderShare, type KneeShare } from './knee.js'
import type { KindResult, Percentiles, RunResult } from './reconcile.js'
import type { Shape, Via } from './plan.js'

/**
 * One file per run, written so the next run of the same shape can be compared
 * without anyone reading a log. Kept under results/, which is not committed: a
 * timing is a fact about the machines that produced it.
 */

export const RECORD_TAG = 'swarm-record/1'

export interface Teardown {
	/** Bee containers removed after the run. */
	readonly removed: number
	/** Containers still carrying this run's label after removal; zero is the only acceptable answer. */
	readonly leftover: number
	readonly verified: boolean
}

export interface RunRecord {
	readonly drexbot: typeof RECORD_TAG
	readonly run: string
	readonly startedAt: string
	readonly finishedAt: string
	readonly target: string
	readonly host: string
	readonly via: Via
	readonly shape: Shape
	readonly shapeKey: string
	readonly result: RunResult
	readonly teardown: Teardown
	/** Anything a reader must know before trusting the numbers. */
	readonly caveats: readonly string[]
	/** The CPUs the store was capped at, as the operator gave them. */
	readonly storeCpus?: number
	/** The deploys the run crossed, from the ledger `--deploy-ledger` named; absent when none was named. */
	readonly deploys?: DeployReport
	/** The fraction of a measured knee the run's users were set from, when `--of-knee` set them. */
	readonly knee?: KneeShare
}

export const recordsDirectory = (results: string): string => join(results, 'swarm')

export const writeRecord = (results: string, record: RunRecord): string => {
	const directory = recordsDirectory(results)
	mkdirSync(directory, { recursive: true })
	const path = join(directory, `${record.run}.json`)
	writeFileSync(path, `${JSON.stringify(record, null, '\t')}\n`)
	return path
}

export const readRecords = (results: string): RunRecord[] => {
	const directory = recordsDirectory(results)
	if (!existsSync(directory)) return []
	return readdirSync(directory)
		.filter(name => name.endsWith('.json'))
		.flatMap(name => {
			try {
				const record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as RunRecord
				return record.drexbot === RECORD_TAG ? [record] : []
			} catch {
				return []
			}
		})
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/** The latest earlier run against the same store with the same shape, which is the only fair comparison. */
export const previousFor = (
	record: Pick<RunRecord, 'run' | 'target' | 'shapeKey' | 'startedAt'>,
	records: readonly RunRecord[],
): RunRecord | undefined =>
	records
		.filter(
			other =>
				other.run !== record.run &&
				other.target === record.target &&
				other.shapeKey === record.shapeKey &&
				other.startedAt < record.startedAt,
		)
		.at(-1)

const ms = (value: number | undefined): string => (value === undefined ? '-' : `${value} ms`)

const change = (now: number | undefined, before: number | undefined): string => {
	if (now === undefined || before === undefined || before === 0) return ''
	const percent = Math.round(((now - before) / before) * 100)
	return percent === 0 ? '  (same)' : `  (${percent > 0 ? '+' : ''}${percent}%)`
}

const line = (label: string, now: Percentiles, before?: Percentiles): string =>
	`  ${label.padEnd(18)} p50 ${ms(now.p50)}${change(now.p50, before?.p50)}   ` +
	`p95 ${ms(now.p95)}${change(now.p95, before?.p95)}   p99 ${ms(now.p99)}`

const JOURNEY_NAMES: Readonly<Record<Journey, string>> = {
	browse: 'browse',
	cart: 'cart and leave',
	order: 'order',
}

const percent = (part: number, whole: number): string =>
	whole === 0 ? '-' : `${((part / whole) * 100).toFixed(2)}%`

/** The step that, served, means an order exists: a browser sees the success page, a protocol bee the order's id. */
const ORDER_PLACED_BY: Readonly<Record<BeeKind, string>> = {
	browser: 'confirmation',
	protocol: 'place-order',
}

/**
 * The shoppers as ratios: the mix asked for beside the mix the run actually
 * drew, each checkout step's time, the step that gives first, and orders per
 * store CPU when the store's cap is known. Never shoppers per minute, which
 * says nothing about a store with other caps.
 */
const checkoutLines = (
	record: RunRecord,
	kind: BeeKind,
	result: KindResult,
	named: boolean,
): string[] => {
	const name = record.shape.mix
	if (name === undefined || name === 'browse') return []
	const set = MIXES[name]
	const journeys = (['browse', 'cart', 'order'] as const).map(journey => ({
		journey,
		taken: result.stages[`${JOURNEY_PREFIX}${journey}`]?.count ?? 0,
		failed: result.stages[`${JOURNEY_PREFIX}${journey}`]?.failures ?? 0,
	}))
	const total = journeys.reduce((sum, j) => sum + j.taken, 0)
	// A protocol bee from a run before protocol bees took the mix wrote no journeys at all.
	if (kind === 'protocol' && total === 0) return []
	const out = [
		'',
		`  shoppers${named ? ` from ${kind} bees` : ''}, mix ${name}: ${total} journeys`,
		`    set     ${journeys.map(j => `${JOURNEY_NAMES[j.journey]} ${percent(set[j.journey], 1)}`).join('   ')}`,
		`    drawn   ${journeys.map(j => `${JOURNEY_NAMES[j.journey]} ${percent(j.taken, total)}`).join('   ')}`,
		`    served  ${journeys.map(j => `${JOURNEY_NAMES[j.journey]} ${j.taken - j.failed} of ${j.taken}`).join('   ')}`,
	]
	const steps = CHECKOUT_STAGES.flatMap(stage => {
		const stepped = result.stages[stage]
		return stepped === undefined ? [] : [{ stage, result: stepped }]
	})
	if (steps.length === 0) return out
	out.push('  checkout steps, the whole step as the shopper waited for it:')
	const width = Math.max(14, ...steps.map(step => step.stage.length))
	for (const { stage, result } of steps) {
		out.push(
			`    ${stage.padEnd(width)} p50 ${ms(result.total.p50)}   p95 ${ms(result.total.p95)}   ` +
				`${result.failures} of ${result.count} failed`,
		)
	}
	const slowest = steps.reduce((worst, step) =>
		(step.result.total.p95 ?? 0) > (worst.result.total.p95 ?? 0) ? step : worst,
	)
	const whole = steps.reduce((sum, step) => sum + (step.result.total.p95 ?? 0), 0)
	out.push(
		`  gives first: ${slowest.stage}, ${percent(slowest.result.total.p95 ?? 0, whole)} of the steps' p95 time`,
	)
	const last = result.stages[ORDER_PLACED_BY[kind]]
	const placed = (last?.count ?? 0) - (last?.failures ?? 0)
	const minutes = record.shape.seconds / 60
	out.push(
		record.storeCpus === undefined
			? `  orders placed: ${placed}; give --store-cpus to read them per store CPU`
			: `  orders placed: ${placed}, ${(placed / minutes / record.storeCpus).toFixed(2)} a minute per store CPU, ` +
					`with the store capped at ${record.storeCpus} CPU(s)`,
	)
	return out
}

/** The record as a person reads it, set beside the previous comparable run when there is one. */
export const renderRecord = (record: RunRecord, previous?: RunRecord): string => {
	const out = [
		'',
		`  ${record.run}  ${record.target}`,
		`  ${record.shapeKey}`,
		...(record.knee === undefined ? [] : [renderShare(record.knee)]),
		previous === undefined
			? '  no earlier run of this shape against this store to compare with'
			: `  compared with ${previous.run}`,
		'',
	]
	const drewJourneys = (result: KindResult | undefined): boolean =>
		Object.keys(result?.stages ?? {}).some(isJourneyStage)
	const bothKinds = drewJourneys(record.result.browser) && drewJourneys(record.result.protocol)
	for (const kind of ['browser', 'protocol'] as const) {
		const now = record.result[kind]
		if (now === undefined) continue
		const before = previous?.result[kind]
		out.push(
			`  ${kind}: ${now.count} requests from ${now.bees} bee(s), ${now.perSecond}/s${change(now.perSecond, before?.perSecond)}, ` +
				`${now.failures} failed` +
				(now.finished < now.bees ? `, ${now.bees - now.finished} bee(s) stopped early` : ''),
		)
		for (const [stage, result] of Object.entries(now.stages)) {
			// Journeys and checkout steps are read in the shoppers' block below.
			if (isJourneyStage(stage) || CHECKOUT_STAGES.includes(stage)) continue
			out.push(line(`${stage} ttfb`, result.ttfb, before?.stages[stage]?.ttfb))
			if (kind === 'browser') {
				out.push(line(`${stage} load`, result.total, before?.stages[stage]?.total))
			}
		}
		out.push(...checkoutLines(record, kind, now, bothKinds))
	}
	const combined = record.result.combined
	out.push(
		'',
		`  the store, under both: ${combined.count} requests, ${combined.failures} failed (${(combined.errorRate * 100).toFixed(2)}%)`,
		line('time to first byte', combined.ttfb, previous?.result.combined.ttfb),
		...(record.deploys === undefined
			? []
			: renderDeploys(record.deploys, record.result.protocol !== undefined)),
		'',
		record.teardown.verified
			? `  teardown verified: ${record.teardown.removed} bee container(s) removed, none left`
			: `  TEARDOWN NOT VERIFIED: ${record.teardown.leftover} container(s) still carry this run's label`,
		...record.caveats.map(caveat => `  note: ${caveat}`),
		'',
	)
	return out.join('\n')
}
