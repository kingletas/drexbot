import { merge, percentile, type Histogram } from '../bee/histogram.js'
import { isJourneyStage, type BeeLine } from '../bee/lines.js'

/**
 * A run's load placed in time, so something that happened mid-run can be
 * matched to what the bees saw then. The browser bee's windows and the
 * protocol bee's ticks are added into windows of fixed length, each named by
 * the instant it ends; the protocol bee's closing totals are not, because
 * they cover the whole run at once.
 */

export interface TimelineWindow {
	/** The instant the window ends. */
	readonly at: string
	readonly count: number
	readonly failures: number
	readonly ttfbP95: number | undefined
}

/** Consecutive windows that share a condition, from the start of the first to the end of the last. */
export interface Span {
	readonly from: string
	readonly to: string
	readonly failures: number
}

export interface Timeline {
	readonly windowSeconds: number
	readonly windows: readonly TimelineWindow[]
	/** Where requests failed. */
	readonly failing: readonly Span[]
	/** Where no request completed at all, between the first window and the last. */
	readonly quiet: readonly Span[]
	/** Protocol bees ran but wrote no ticks, so only the browser bees are placed in time. */
	readonly protocolMissing?: true
}

interface Sum {
	count: number
	failures: number
	ttfb: Histogram
}

const spansWhere = (
	windows: readonly TimelineWindow[],
	windowMs: number,
	holds: (window: TimelineWindow) => boolean,
): Span[] => {
	const spans: Span[] = []
	let open: { from: number; to: number; failures: number } | undefined
	for (const window of windows) {
		const end = Date.parse(window.at)
		if (holds(window)) {
			open ??= { from: end - windowMs, to: end, failures: 0 }
			open.to = end
			open.failures += window.failures
		} else if (open !== undefined) {
			spans.push(spanOf(open))
			open = undefined
		}
	}
	if (open !== undefined) spans.push(spanOf(open))
	return spans
}

const spanOf = (open: { from: number; to: number; failures: number }): Span => ({
	from: new Date(open.from).toISOString(),
	to: new Date(open.to).toISOString(),
	failures: open.failures,
})

export const timelineOf = (lines: readonly BeeLine[], windowSeconds = 10): Timeline | undefined => {
	const windowMs = windowSeconds * 1_000
	const sums = new Map<number, Sum>()
	for (const line of lines) {
		const placed =
			(line.event === 'window' && line.kind === 'browser') ||
			(line.event === 'tick' && line.kind === 'protocol')
		if (!placed || isJourneyStage(line.stage)) continue
		const at = Date.parse(line.at)
		if (Number.isNaN(at)) continue
		const end = Math.ceil(at / windowMs) * windowMs
		const sum = sums.get(end) ?? { count: 0, failures: 0, ttfb: {} }
		sums.set(end, sum)
		sum.count += line.count
		sum.failures += line.failures
		merge(sum.ttfb, line.ttfb)
	}
	if (sums.size === 0) return undefined
	const ends = [...sums.keys()]
	const first = Math.min(...ends)
	const last = Math.max(...ends)
	const windows: TimelineWindow[] = []
	for (let end = first; end <= last; end += windowMs) {
		const sum = sums.get(end) ?? { count: 0, failures: 0, ttfb: {} }
		windows.push({
			at: new Date(end).toISOString(),
			count: sum.count,
			failures: sum.failures,
			ttfbP95: percentile(sum.ttfb, 0.95),
		})
	}
	const protocolRan = lines.some(line => line.kind === 'protocol')
	const protocolTicked = lines.some(line => line.event === 'tick')
	return {
		windowSeconds,
		windows,
		failing: spansWhere(windows, windowMs, window => window.failures > 0),
		quiet: spansWhere(windows, windowMs, window => window.count === 0),
		...(protocolRan && !protocolTicked ? { protocolMissing: true as const } : {}),
	}
}

const clock = (iso: string): string => iso.slice(11, 19)

/** The timeline as a few lines a person reads: when failures began and ended, and any stretch where nothing completed. */
export const renderTimeline = (timeline: Timeline): string[] => {
	const first = timeline.windows[0]
	const last = timeline.windows.at(-1)
	if (first === undefined || last === undefined) return []
	const from = new Date(Date.parse(first.at) - timeline.windowSeconds * 1_000).toISOString()
	const out = [
		`  timeline, ${timeline.windowSeconds}s windows from ${clock(from)} to ${clock(last.at)} UTC:`,
	]
	if (timeline.failing.length === 0) out.push('    no window had a failure')
	for (const span of timeline.failing) {
		out.push(`    failures from ${clock(span.from)} to ${clock(span.to)}: ${span.failures} failed`)
	}
	for (const span of timeline.quiet) {
		out.push(`    no request completed from ${clock(span.from)} to ${clock(span.to)}`)
	}
	if (timeline.protocolMissing === true) {
		out.push('    the protocol bees wrote no timeline, so only the browser bees are placed in time')
	}
	return out
}
