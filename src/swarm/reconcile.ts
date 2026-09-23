import { countOf, merge, percentile, type Histogram } from '../bee/histogram.js'
import type { BeeKind, BeeLine, StageWindow } from '../bee/lines.js'

/**
 * Every bee's lines, added into one result. Histograms add exactly, so the
 * percentiles here are for all requests of a kind together, not an average of
 * each bee's percentiles, which would mean nothing.
 */

export interface Percentiles {
	readonly p50: number | undefined
	readonly p95: number | undefined
	readonly p99: number | undefined
}

export interface StageResult {
	readonly count: number
	readonly failures: number
	readonly statuses: Record<string, number>
	readonly ttfb: Percentiles
	readonly total: Percentiles
	readonly lcp?: Percentiles
}

export interface KindResult {
	readonly bees: number
	/** Bees that wrote their closing line; fewer than `bees` means some were stopped early. */
	readonly finished: number
	readonly count: number
	readonly failures: number
	readonly perSecond: number
	readonly ttfb: Percentiles
	readonly stages: Record<string, StageResult>
}

export interface RunResult {
	readonly browser?: KindResult
	readonly protocol?: KindResult
	/** Time to first byte over every request of both kinds: what the store did under the whole load. */
	readonly combined: {
		readonly count: number
		readonly failures: number
		readonly errorRate: number
		readonly ttfb: Percentiles
	}
}

const percentilesOf = (histogram: Histogram): Percentiles => ({
	p50: percentile(histogram, 0.5),
	p95: percentile(histogram, 0.95),
	p99: percentile(histogram, 0.99),
})

interface Sum {
	count: number
	failures: number
	statuses: Record<string, number>
	ttfb: Histogram
	total: Histogram
	lcp: Histogram
}

const emptySum = (): Sum => ({ count: 0, failures: 0, statuses: {}, ttfb: {}, total: {}, lcp: {} })

const add = (sum: Sum, window: StageWindow): void => {
	sum.count += window.count
	sum.failures += window.failures
	merge(sum.statuses, window.statuses)
	merge(sum.ttfb, window.ttfb)
	merge(sum.total, window.total)
	if (window.lcp !== undefined) merge(sum.lcp, window.lcp)
}

const kindResult = (
	lines: readonly BeeLine[],
	kind: BeeKind,
	seconds: number,
): KindResult | undefined => {
	const mine = lines.filter(line => line.kind === kind)
	const bees = new Set(mine.map(line => line.bee))
	if (bees.size === 0) return undefined
	const stages = new Map<string, Sum>()
	const all = emptySum()
	for (const line of mine) {
		if (line.event !== 'window') continue
		const sum = stages.get(line.stage) ?? emptySum()
		stages.set(line.stage, sum)
		add(sum, line)
		add(all, line)
	}
	return {
		bees: bees.size,
		finished: new Set(mine.filter(line => line.event === 'finished').map(line => line.bee)).size,
		count: all.count,
		failures: all.failures,
		perSecond: Math.round((all.count / seconds) * 10) / 10,
		ttfb: percentilesOf(all.ttfb),
		stages: Object.fromEntries(
			[...stages.entries()].map(([stage, sum]) => [
				stage,
				{
					count: sum.count,
					failures: sum.failures,
					statuses: sum.statuses,
					ttfb: percentilesOf(sum.ttfb),
					total: percentilesOf(sum.total),
					...(countOf(sum.lcp) > 0 ? { lcp: percentilesOf(sum.lcp) } : {}),
				},
			]),
		),
	}
}

export const reconcile = (lines: readonly BeeLine[], seconds: number): RunResult => {
	const browser = kindResult(lines, 'browser', seconds)
	const protocol = kindResult(lines, 'protocol', seconds)
	const ttfb: Histogram = {}
	let count = 0
	let failures = 0
	for (const line of lines) {
		if (line.event !== 'window') continue
		merge(ttfb, line.ttfb)
		count += line.count
		failures += line.failures
	}
	return {
		...(browser === undefined ? {} : { browser }),
		...(protocol === undefined ? {} : { protocol }),
		combined: {
			count,
			failures,
			errorRate: count === 0 ? 0 : Math.round((failures / count) * 10_000) / 10_000,
			ttfb: percentilesOf(ttfb),
		},
	}
}
