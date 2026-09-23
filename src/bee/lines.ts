import { record, type Histogram } from './histogram.js'

/**
 * What a bee writes to standard output, one JSON object per line. Standard
 * output is the one channel every place a bee runs can hand back: local Docker,
 * Docker on another machine, an ECS task's log. The conductor keeps the lines
 * tagged `drexbot: 'bee/1'` and ignores anything else a base image prints.
 */
export const LINE_TAG = 'bee/1'

export type BeeKind = 'browser' | 'protocol'

/** Counts for one stage over one window; windows add, so a killed bee loses only its last one. */
export interface StageWindow {
	readonly drexbot: typeof LINE_TAG
	readonly event: 'window'
	readonly run: string
	readonly bee: string
	readonly kind: BeeKind
	readonly at: string
	readonly stage: string
	readonly count: number
	readonly failures: number
	/** Status codes as strings, `error` for a request that got no response. */
	readonly statuses: Record<string, number>
	/** Time to first byte. The one measure both kinds take the same way. */
	readonly ttfb: Histogram
	/** Browser: navigation start to the load event. Protocol: the whole response. */
	readonly total: Histogram
	/** Browser only: largest contentful paint. */
	readonly lcp?: Histogram
}

export interface BeeEvent {
	readonly drexbot: typeof LINE_TAG
	readonly event: 'started' | 'finished'
	readonly run: string
	readonly bee: string
	readonly kind: BeeKind
	readonly at: string
	/** Browser workers or protocol virtual users this bee ran. */
	readonly concurrency: number
	readonly note?: string
}

export type BeeLine = StageWindow | BeeEvent

export interface Sample {
	readonly stage: string
	/** Undefined when the request got no response at all. */
	readonly status: number | undefined
	readonly ttfbMs?: number
	readonly totalMs?: number
	readonly lcpMs?: number
}

/** A 2xx or 3xx is a page served; anything else, or no response, is a failure. */
export const failed = (status: number | undefined): boolean =>
	status === undefined || status < 200 || status >= 400

interface Tally {
	count: number
	failures: number
	statuses: Record<string, number>
	ttfb: Histogram
	total: Histogram
	lcp: Histogram
}

/** Collects samples per stage and hands back what arrived since the last flush. */
export class Windows {
	private tallies = new Map<string, Tally>()

	constructor(
		private readonly identity: {
			readonly run: string
			readonly bee: string
			readonly kind: BeeKind
		},
	) {}

	add(sample: Sample): void {
		const tally = this.tallies.get(sample.stage) ?? {
			count: 0,
			failures: 0,
			statuses: {},
			ttfb: {},
			total: {},
			lcp: {},
		}
		this.tallies.set(sample.stage, tally)
		tally.count += 1
		if (failed(sample.status)) tally.failures += 1
		const status = sample.status === undefined ? 'error' : String(sample.status)
		tally.statuses[status] = (tally.statuses[status] ?? 0) + 1
		if (sample.ttfbMs !== undefined) record(tally.ttfb, sample.ttfbMs)
		if (sample.totalMs !== undefined) record(tally.total, sample.totalMs)
		if (sample.lcpMs !== undefined && sample.lcpMs > 0) record(tally.lcp, sample.lcpMs)
	}

	flush(at: Date = new Date()): StageWindow[] {
		const windows = [...this.tallies.entries()].map(([stage, tally]): StageWindow => ({
			drexbot: LINE_TAG,
			event: 'window',
			...this.identity,
			at: at.toISOString(),
			stage,
			count: tally.count,
			failures: tally.failures,
			statuses: tally.statuses,
			ttfb: tally.ttfb,
			total: tally.total,
			...(Object.keys(tally.lcp).length > 0 ? { lcp: tally.lcp } : {}),
		}))
		this.tallies = new Map()
		return windows
	}
}

/** The lines in some output that a bee wrote, skipping whatever else shared the stream. */
export const beeLinesIn = (output: string): BeeLine[] =>
	output.split('\n').flatMap(line => {
		const start = line.indexOf('{"drexbot":"bee/1"')
		if (start === -1) return []
		try {
			return [JSON.parse(line.slice(start)) as BeeLine]
		} catch {
			return []
		}
	})
