import { readFileSync } from 'node:fs'
import { merge, percentile, type Histogram } from '../bee/histogram.js'
import { isJourneyStage, type BeeLine, type StageWindow } from '../bee/lines.js'

/**
 * Which deploys happened while a run was loading the store, read from the
 * deploy tool's own audit log: one JSON object per line, appended and never
 * rewritten. A run that crosses a deploy is only readable as before, during and
 * after it, so the record carries the deploy's times as seconds from the run's
 * start. This module reads the log and does not verify its hash chain.
 */

/** A deploy counts when any part of it falls within this many seconds of the run, either side. */
export const DEPLOY_MARGIN_SECONDS = 60

export interface LedgerRecord {
	readonly event: string
	readonly env: string
	readonly release: string
	readonly at: string
	readonly time: number
	readonly outcome?: string
	readonly byHand: boolean
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** The ledger's records in file order. A line that is not one is refused, naming the file and the line. */
export const parseLedger = (text: string, file: string): LedgerRecord[] =>
	text.split('\n').flatMap((raw, index) => {
		if (raw.trim() === '') return []
		const refuse = (why: string): never => {
			throw new Error(`deploy ledger ${file}, line ${index + 1}: ${why}`)
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			return refuse('not JSON, so not a record')
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return refuse('not a JSON object, so not a record')
		}
		const fields = parsed as Record<string, unknown>
		const event = fields['event']
		if (typeof event !== 'string' || event === '') return refuse('no "event"')
		const at = fields['recorded_at']
		if (typeof at !== 'string' || !STAMP.test(at) || Number.isNaN(Date.parse(at))) {
			return refuse('"recorded_at" is not a UTC time like 2026-01-01T00:00:00Z')
		}
		const outcome = fields['outcome']
		return [
			{
				event,
				env: typeof fields['env_name'] === 'string' ? fields['env_name'] : '',
				release: typeof fields['release'] === 'string' ? fields['release'] : '',
				at,
				time: Date.parse(at),
				byHand: fields['by_hand'] === true,
				...(typeof outcome === 'string' ? { outcome } : {}),
			},
		]
	})

export const readLedger = (file: string): LedgerRecord[] => {
	let text: string
	try {
		text = readFileSync(file, 'utf8')
	} catch (cause) {
		throw new Error(
			`deploy ledger ${file} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
		)
	}
	return parseLedger(text, file)
}

/** A stretch of a deploy, from the record that opens it to the first record after it that closes it. */
const PHASES: readonly { name: string; opens: string; closes: readonly string[] }[] = [
	{ name: 'build', opens: 'build.started', closes: ['build.succeeded'] },
	{ name: 'upload', opens: 'upload.started', closes: ['upload.succeeded'] },
	{ name: 'cutover', opens: 'cutover.started', closes: ['cutover.succeeded'] },
	{
		name: 'setup:upgrade',
		opens: 'upgrade.started',
		closes: ['upgrade.succeeded', 'upgrade.failed'],
	},
]

/** Times as the ledger wrote them and as seconds from the run's start, negative before it. */
export interface Span {
	readonly startedAt: string
	/** Absent when the ledger holds no record that ends it. */
	readonly endedAt?: string
	readonly startedSeconds: number
	readonly endedSeconds?: number
	readonly seconds?: number
}

export interface Phase extends Span {
	readonly name: string
}

export interface MaintenanceWindow extends Span {
	/** False when no `maintenance.disabled` follows: the store may still be in maintenance. */
	readonly closed: boolean
	/** True when a person wrote the closing record, so its time is when they wrote it. */
	readonly closedByHand?: boolean
}

/** What the browser bees' interval windows add up to on one side of a stretch of time. */
export interface Share {
	readonly windows: number
	readonly requests: number
	readonly failures: number
	readonly ttfbP95: number | undefined
}

export interface Split {
	readonly around: 'deploy' | 'maintenance window'
	readonly before: Share
	readonly during: Share
	readonly after: Share
}

export interface DeployWindow extends Span {
	readonly release: string
	readonly env: string
	/** `success` or `rolled_back` from `deploy.finished`, `failed`, or `not closed`. */
	readonly outcome: string
	readonly maintenance?: MaintenanceWindow
	readonly phases: readonly Phase[]
	/** Empty when no browser bee ran, since only browser bees write interval windows. */
	readonly splits: readonly Split[]
}

export interface DeployReport {
	readonly ledger: string
	readonly marginSeconds: number
	/** Records read from the ledger. */
	readonly records: number
	readonly deploys: readonly DeployWindow[]
	/** Set when the ledger was refused, in which case nothing else here is known. */
	readonly refused?: string
}

/** What a run needs to say where it sat in time. */
interface RunSpan {
	readonly startedAt: string
	readonly finishedAt: string
}

/** A deploy is a release's records from one `deploy.started` to the next for that release, so a late hand-written closing record still finds its deploy. */
const deploysIn = (records: readonly LedgerRecord[]): LedgerRecord[][] =>
	records.flatMap((first, index) => {
		if (first.event !== 'deploy.started') return []
		const next = records.findIndex(
			(other, at) =>
				at > index &&
				other.event === 'deploy.started' &&
				other.env === first.env &&
				other.release === first.release,
		)
		return [
			records
				.slice(index, next === -1 ? records.length : next)
				.filter(other => other.env === first.env && other.release === first.release),
		]
	})

const spanBetween = (
	start: LedgerRecord,
	end: LedgerRecord | undefined,
	runStart: number,
): Span => {
	const seconds = (time: number): number => Math.round((time - runStart) / 1_000)
	return {
		startedAt: start.at,
		startedSeconds: seconds(start.time),
		...(end === undefined
			? {}
			: {
					endedAt: end.at,
					endedSeconds: seconds(end.time),
					seconds: Math.round((end.time - start.time) / 1_000),
				}),
	}
}

const closing = (
	deploy: readonly LedgerRecord[],
	start: LedgerRecord,
	closes: readonly string[],
): LedgerRecord | undefined =>
	deploy.slice(deploy.indexOf(start) + 1).find(record => closes.includes(record.event))

/**
 * The browser bees' windows, each placed by the stretch of time it covers: a
 * window that ended before the stretch began is before it, one that began after
 * the stretch ended is after it, and any window that overlaps it is during it.
 * A window's start is its bee's previous flush, or the bee's own start.
 */
const splitAround = (
	around: Split['around'],
	from: number,
	to: number,
	lines: readonly BeeLine[],
): Split => {
	const sides = {
		before: [] as StageWindow[],
		during: [] as StageWindow[],
		after: [] as StageWindow[],
	}
	const browser = lines.filter(line => line.kind === 'browser')
	for (const bee of new Set(browser.map(line => line.bee))) {
		const mine = browser.filter(line => line.bee === bee)
		const marks = [...new Set(mine.map(line => Date.parse(line.at)))].sort((a, b) => a - b)
		for (const line of mine) {
			if (line.event !== 'window' || isJourneyStage(line.stage)) continue
			const end = Date.parse(line.at)
			const start = marks.filter(mark => mark < end).at(-1)
			const side = end <= from ? 'before' : start !== undefined && start >= to ? 'after' : 'during'
			sides[side].push(line)
		}
	}
	const share = (windows: readonly StageWindow[]): Share => {
		const ttfb: Histogram = {}
		for (const window of windows) merge(ttfb, window.ttfb)
		return {
			windows: new Set(windows.map(window => `${window.bee}@${window.at}`)).size,
			requests: windows.reduce((sum, window) => sum + window.count, 0),
			failures: windows.reduce((sum, window) => sum + window.failures, 0),
			ttfbP95: percentile(ttfb, 0.95),
		}
	}
	return {
		around,
		before: share(sides.before),
		during: share(sides.during),
		after: share(sides.after),
	}
}

/**
 * The deploys in the ledger that fall within the run, with the browser bees'
 * windows split around each. A deploy still open at the end of the ledger
 * counts as lasting until the run ended.
 */
export const deployWindows = (
	records: readonly LedgerRecord[],
	run: RunSpan,
	lines: readonly BeeLine[] = [],
	marginSeconds: number = DEPLOY_MARGIN_SECONDS,
): DeployWindow[] => {
	const runStart = Date.parse(run.startedAt)
	const runEnd = Date.parse(run.finishedAt)
	const margin = marginSeconds * 1_000
	const hasBrowser = lines.some(line => line.kind === 'browser')
	return deploysIn(records).flatMap(deploy => {
		const [start] = deploy
		if (start === undefined) return []
		const last = deploy.at(-1) ?? start
		if (last.time < runStart - margin || start.time > runEnd + margin) return []

		const end = closing(deploy, start, ['deploy.finished', 'deploy.failed'])
		const outcome =
			end === undefined
				? 'not closed'
				: end.event === 'deploy.failed'
					? 'failed'
					: (end.outcome ?? 'finished')
		const phases = PHASES.flatMap(({ name, opens, closes }): Phase[] => {
			const opened = deploy.find(record => record.event === opens)
			return opened === undefined
				? []
				: [{ name, ...spanBetween(opened, closing(deploy, opened, closes), runStart) }]
		})
		const enabled = deploy.find(record => record.event === 'maintenance.enabled')
		const disabled =
			enabled === undefined ? undefined : closing(deploy, enabled, ['maintenance.disabled'])
		const maintenance: MaintenanceWindow | undefined =
			enabled === undefined
				? undefined
				: {
						...spanBetween(enabled, disabled, runStart),
						closed: disabled !== undefined,
						...(disabled?.byHand === true ? { closedByHand: true } : {}),
					}
		const around = (
			name: Split['around'],
			from: LedgerRecord,
			to: LedgerRecord | undefined,
		): Split => splitAround(name, from.time, to?.time ?? Number.POSITIVE_INFINITY, lines)
		return [
			{
				release: start.release,
				env: start.env,
				outcome,
				...spanBetween(start, end, runStart),
				...(maintenance === undefined ? {} : { maintenance }),
				phases,
				splits: !hasBrowser
					? []
					: [
							around('deploy', start, end),
							...(enabled === undefined ? [] : [around('maintenance window', enabled, disabled)]),
						],
			},
		]
	})
}

/** The report for a run. A ledger that is refused is recorded as refused, so a long run's numbers are never lost to it. */
export const deployReport = (
	file: string,
	run: RunSpan,
	lines: readonly BeeLine[],
	marginSeconds: number = DEPLOY_MARGIN_SECONDS,
): DeployReport => {
	try {
		const records = readLedger(file)
		return {
			ledger: file,
			marginSeconds,
			records: records.length,
			deploys: deployWindows(records, run, lines, marginSeconds),
		}
	} catch (cause) {
		return {
			ledger: file,
			marginSeconds,
			records: 0,
			deploys: [],
			refused: cause instanceof Error ? cause.message : String(cause),
		}
	}
}

const offset = (seconds: number): string => `${seconds < 0 ? '-' : '+'}${Math.abs(seconds)}s`

const stretch = (span: Span): string =>
	span.endedAt === undefined || span.endedSeconds === undefined
		? `from ${offset(span.startedSeconds)} (${span.startedAt}), no end recorded`
		: `${offset(span.startedSeconds)} to ${offset(span.endedSeconds)}, ${span.seconds ?? 0}s ` +
			`(${span.startedAt} to ${span.endedAt})`

const shareLine = (label: string, share: Share): string => {
	const rate =
		share.requests === 0 ? '' : ` (${((share.failures / share.requests) * 100).toFixed(2)}%)`
	return (
		`      ${label.padEnd(7)} ${String(share.windows).padStart(3)} windows  ` +
		`${share.requests} requests  ${share.failures} failed${rate}  ` +
		`ttfb p95 ${share.ttfbP95 === undefined ? '-' : `${share.ttfbP95} ms`}`
	)
}

/** The deploys as a person reads them, one line each, the maintenance window under it, then the split. */
export const renderDeploys = (report: DeployReport, protocolBees: boolean): string[] => {
	if (report.refused !== undefined) return ['', `  DEPLOY LEDGER REFUSED: ${report.refused}`]
	const out = ['']
	if (report.deploys.length === 0) {
		out.push(
			`  no deploy in ${report.ledger} fell within the run, give or take ${report.marginSeconds}s ` +
				`(${report.records} records read)`,
		)
		return out
	}
	out.push(
		`  deploys within the run, give or take ${report.marginSeconds}s, from ${report.ledger} ` +
			`(times are the control node's clock, seconds are from the run's start):`,
	)
	for (const deploy of report.deploys) {
		out.push(`  deploy ${deploy.release} on ${deploy.env}: ${deploy.outcome}, ${stretch(deploy)}`)
		const window = deploy.maintenance
		if (window !== undefined) {
			out.push(
				window.closed
					? `    maintenance window: ${stretch(window)}${window.closedByHand === true ? ', closed by hand' : ''}`
					: `    maintenance window: opened ${offset(window.startedSeconds)} (${window.startedAt}), ` +
							'not closed: no maintenance.disabled follows it',
			)
		}
		for (const split of deploy.splits) {
			out.push(`    browser bees' windows around the ${split.around}:`)
			out.push(shareLine('before', split.before), shareLine('during', split.during))
			out.push(shareLine('after', split.after))
		}
	}
	if (protocolBees) {
		out.push(
			'  protocol bees write one window for the whole run, so they are not split around a deploy',
		)
	}
	return out
}
