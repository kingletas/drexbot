import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deployWindows, type LedgerRecord } from './deploys.js'
import { intervalText, ordersAskedFor } from './orders.js'
import { checkoutP95Of, ordersOf, recordsDirectory, type RunRecord } from './record.js'

/**
 * A day of shop runs, each placed before, during or after the day's deploys.
 * Before and after are the same length, a span either side of the deploy, so
 * the two compare like with like: the rest of the day, at another rate and
 * with more runs, would read worse after any deploy. A run's record keeps
 * percentiles and not histograms, so a band's checkout p95 is the highest of
 * its runs' p95s: an upper reading, never an average.
 */

/** Seconds either side of a deploy that its before and after bands cover, unless `--around` says. */
export const DEFAULT_AROUND_SECONDS = 2 * 3600

export type BandName = 'before' | 'during' | 'after' | 'whole day'

export interface BandTotals {
	readonly band: BandName
	readonly runs: number
	/** Orders the runs asked for, over the runs that say; null when none does. */
	readonly asked: number | null
	/** How many of the band's runs say how many orders they asked for. */
	readonly askedRuns: number
	readonly placed: number
	readonly failures: number
	/** The highest checkout p95 among the runs, in ms; null when none walked the checkout. */
	readonly highestCheckoutP95: number | null
}

export interface DayDeploy {
	readonly release: string
	readonly env: string
	readonly outcome: string
	readonly startedAt: string
	/** Absent when the ledger never closes the deploy, which then counts as lasting to the day's end. */
	readonly endedAt?: string
	readonly bands: readonly BandTotals[]
	/** The day's runs outside the deploy and the span either side of it, in no band. */
	readonly outside: number
}

export interface DayStore {
	readonly target: string
	readonly runs: number
	/** Set when the day held no deploy: the whole day as one band. */
	readonly wholeDay?: BandTotals
	readonly deploys: readonly DayDeploy[]
}

export interface DayReport {
	readonly date: string
	readonly ledger: string
	/** The deploys the ledger holds for the day, all stores together. */
	readonly deploys: number
	/** The seconds either side of each deploy that its before and after bands cover. */
	readonly aroundSeconds: number
	readonly stores: readonly DayStore[]
}

/** The local day `YYYY-MM-DD` as the instants it starts and ends, or why it is not a date. */
export const dayBounds = (date: string): { from: Date; to: Date } | string => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
	const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])]
	const from = new Date(year, month - 1, day)
	if (match === null || from.getMonth() !== month - 1 || from.getDate() !== day) {
		return `"${date}" is not a date like 2026-11-01`
	}
	return { from, to: new Date(year, month - 1, day + 1) }
}

/** The same store whatever the trailing slash. */
const sameStore = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * The orders a run asked for, from the rate it was given, or undefined for a
 * record made before runs took one.
 */
export const ordersAsked = (record: RunRecord): number | undefined => {
	const orders = record.shape.orders
	if (orders === undefined || !(orders.perSeconds > 0)) return undefined
	return ordersAskedFor(orders, record.shape.seconds)
}

const totals = (band: BandName, runs: readonly RunRecord[]): BandTotals => {
	const asked = runs.flatMap(run => {
		const count = ordersAsked(run)
		return count === undefined ? [] : [count]
	})
	const p95s = runs.flatMap(run => {
		const p95 = checkoutP95Of(run)
		return p95 === undefined ? [] : [p95]
	})
	return {
		band,
		runs: runs.length,
		asked: asked.length === 0 ? null : asked.reduce((sum, count) => sum + count, 0),
		askedRuns: asked.length,
		placed: runs.reduce((sum, run) => sum + ordersOf(run), 0),
		failures: runs.reduce((sum, run) => sum + run.result.combined.failures, 0),
		highestCheckoutP95: p95s.length === 0 ? null : Math.max(...p95s),
	}
}

/**
 * A run is during a deploy when it overlaps it; before it when it ended by the
 * deploy's start and began within `around` of it; after it when it began at or
 * after the deploy's end and ended within `around` of it; otherwise in no band.
 */
const placeAgainst = (
	run: RunRecord,
	from: number,
	to: number,
	around: number,
): Exclude<BandName, 'whole day'> | undefined => {
	const started = Date.parse(run.startedAt)
	const finished = Date.parse(run.finishedAt)
	if (finished <= from) return started >= from - around ? 'before' : undefined
	if (started >= to) return finished <= to + around ? 'after' : undefined
	return 'during'
}

/** The report for `date`: every run that started that local day, for one store when `url` is given. */
export const dayReport = (
	date: string,
	records: readonly RunRecord[],
	ledger: readonly LedgerRecord[],
	ledgerFile: string,
	url?: string,
	aroundSeconds: number = DEFAULT_AROUND_SECONDS,
): DayReport | string => {
	const around = aroundSeconds * 1000
	const bounds = dayBounds(date)
	if (typeof bounds === 'string') return bounds
	const { from, to } = bounds
	const deploys = deployWindows(
		ledger,
		{ startedAt: from.toISOString(), finishedAt: to.toISOString() },
		[],
		0,
	)
	const ofTheDay = records.filter(record => {
		const started = Date.parse(record.startedAt)
		return (
			started >= from.getTime() &&
			started < to.getTime() &&
			(url === undefined || sameStore(record.target, url))
		)
	})
	const targets = [...new Set(ofTheDay.map(record => record.target))].sort()
	const stores = targets.map((target): DayStore => {
		const runs = ofTheDay.filter(record => record.target === target)
		return {
			target,
			runs: runs.length,
			...(deploys.length === 0 ? { wholeDay: totals('whole day', runs) } : {}),
			deploys: deploys.map(deploy => {
				const start = Date.parse(deploy.startedAt)
				const end = deploy.endedAt === undefined ? to.getTime() : Date.parse(deploy.endedAt)
				return {
					release: deploy.release,
					env: deploy.env,
					outcome: deploy.outcome,
					startedAt: deploy.startedAt,
					...(deploy.endedAt === undefined ? {} : { endedAt: deploy.endedAt }),
					bands: (['before', 'during', 'after'] as const).map(band =>
						totals(
							band,
							runs.filter(run => placeAgainst(run, start, end, around) === band),
						),
					),
					outside: runs.filter(run => placeAgainst(run, start, end, around) === undefined).length,
				}
			}),
		}
	})
	return { date, ledger: ledgerFile, deploys: deploys.length, aroundSeconds, stores }
}

const cell = (value: number | null): string => (value === null ? '-' : String(value))

const askedCell = (band: BandTotals): string =>
	band.asked === null || band.askedRuns === band.runs
		? cell(band.asked)
		: `${band.asked} (${band.askedRuns} of ${band.runs} runs say)`

const table = (bands: readonly BandTotals[]): string[] => {
	const rows = bands.map(band => [
		band.band,
		String(band.runs),
		askedCell(band),
		String(band.placed),
		String(band.failures),
		band.highestCheckoutP95 === null ? '-' : `${band.highestCheckoutP95} ms`,
	])
	const head = [
		'',
		'runs',
		'orders asked',
		'orders placed',
		'failed requests',
		"checkout p95, highest run's",
	]
	const widths = head.map((title, i) =>
		Math.max(title.length, ...rows.map(row => row[i]?.length ?? 0)),
	)
	const format = (row: readonly string[]): string =>
		`      ${row.map((value, i) => value.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd()
	return [format(head), ...rows.map(format)]
}

/** The day as a person reads it. */
export const renderDay = (report: DayReport): string => {
	const out = [
		'',
		`  ${report.date} (local time), deploys from ${report.ledger}: ${report.deploys} that day`,
	]
	if (report.stores.length === 0) out.push('', '  no run started that day')
	for (const store of report.stores) {
		out.push('', `  ${store.target}: ${store.runs} run(s)`)
		if (store.wholeDay !== undefined) {
			out.push('    no deploy that day, so the whole day is one band', ...table([store.wholeDay]))
		}
		for (const deploy of store.deploys) {
			out.push(
				'',
				`    deploy ${deploy.release} on ${deploy.env}: ${deploy.outcome}, ${deploy.startedAt} to ` +
					(deploy.endedAt ?? 'no end recorded, so taken as the end of the day'),
				...table(deploy.bands),
				`      ${deploy.outside} run(s) of the day fall outside these bands`,
			)
		}
	}
	out.push(
		'',
		`  before and after are each the ${intervalText(report.aroundSeconds)} either side of a deploy, so they compare like with like;`,
		'  orders asked is what each run was given (--orders over --per), "-" when a record has none;',
		"  checkout p95 is the highest of the runs' p95s, since records keep percentiles and not histograms",
		'',
	)
	return out.join('\n')
}

/** Where the day's report is written, beside the run records. */
export const dayPath = (results: string, date: string): string =>
	join(recordsDirectory(results), 'day', `${date}.json`)

export const writeDay = (results: string, report: DayReport): string => {
	const path = dayPath(results, report.date)
	mkdirSync(join(recordsDirectory(results), 'day'), { recursive: true })
	writeFileSync(path, `${JSON.stringify(report, null, '\t')}\n`)
	return path
}
