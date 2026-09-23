/**
 * Latency histograms that add exactly across bees, where percentiles cannot; a percentile reads as its bucket's upper bound.
 * `bees/protocol/bee.js` repeats the three constants below, and a unit test holds the copies equal.
 */
export const FIRST_BOUND_MS = 1
export const GROWTH = 1.25
export const BUCKETS = 50

/** Sparse counts by bucket index, which keeps a quiet stage's line short. */
export type Histogram = Record<string, number>

export const bucketOf = (ms: number): number => {
	if (!(ms > FIRST_BOUND_MS)) return 0
	const bucket = Math.ceil(Math.log(ms / FIRST_BOUND_MS) / Math.log(GROWTH))
	return Math.min(bucket, BUCKETS - 1)
}

/** The largest value a bucket holds; the last bucket is open-ended and reports its lower edge. */
export const upperBoundOf = (bucket: number): number =>
	Math.round(FIRST_BOUND_MS * GROWTH ** bucket)

export const record = (histogram: Histogram, ms: number): void => {
	const key = String(bucketOf(ms))
	histogram[key] = (histogram[key] ?? 0) + 1
}

export const merge = (into: Histogram, from: Histogram): Histogram => {
	for (const [bucket, count] of Object.entries(from)) into[bucket] = (into[bucket] ?? 0) + count
	return into
}

export const countOf = (histogram: Histogram): number =>
	Object.values(histogram).reduce((sum, count) => sum + count, 0)

/** The value at or under which `fraction` of the samples fall, or undefined for an empty histogram. */
export const percentile = (histogram: Histogram, fraction: number): number | undefined => {
	const total = countOf(histogram)
	if (total === 0) return undefined
	const wanted = Math.max(1, Math.ceil(total * fraction))
	let seen = 0
	for (const bucket of Object.keys(histogram)
		.map(Number)
		.sort((a, b) => a - b)) {
		seen += histogram[String(bucket)] ?? 0
		if (seen >= wanted) return upperBoundOf(bucket)
	}
	return undefined
}
