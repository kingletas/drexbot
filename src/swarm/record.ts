import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Percentiles, RunResult } from './reconcile.js'
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

/** The record as a person reads it, set beside the previous comparable run when there is one. */
export const renderRecord = (record: RunRecord, previous?: RunRecord): string => {
	const out = [
		'',
		`  ${record.run}  ${record.target}`,
		`  ${record.shapeKey}`,
		previous === undefined
			? '  no earlier run of this shape against this store to compare with'
			: `  compared with ${previous.run}`,
		'',
	]
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
			out.push(line(`${stage} ttfb`, result.ttfb, before?.stages[stage]?.ttfb))
			if (kind === 'browser') {
				out.push(line(`${stage} load`, result.total, before?.stages[stage]?.total))
			}
		}
	}
	const combined = record.result.combined
	out.push(
		'',
		`  the store, under both: ${combined.count} requests, ${combined.failures} failed (${(combined.errorRate * 100).toFixed(2)}%)`,
		line('time to first byte', combined.ttfb, previous?.result.combined.ttfb),
		'',
		record.teardown.verified
			? `  teardown verified: ${record.teardown.removed} bee container(s) removed, none left`
			: `  TEARDOWN NOT VERIFIED: ${record.teardown.leftover} container(s) still carry this run's label`,
		...record.caveats.map(caveat => `  note: ${caveat}`),
		'',
	)
	return out.join('\n')
}
