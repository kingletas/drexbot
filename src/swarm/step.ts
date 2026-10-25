/**
 * The step test: how many users a store holds before it reaches its knee.
 * Users double from a start until a step goes bad, then halve the gap between
 * the last good step and the first bad one until it is narrow enough. A bad
 * step is the knee, never the break: the test stops there, and a step whose
 * errors pass the break rate stops it at once, whatever is left to try.
 */

/** What one step of load did to the store, read from its run record. */
export interface StepOutcome {
	readonly users: number
	/** The checkout steps' p95 total time, the slowest of them; undefined when none ran. */
	readonly checkoutP95: number | undefined
	readonly requests: number
	readonly failures: number
}

export type Verdict = 'good' | 'knee' | 'break'

export interface Judged extends StepOutcome {
	readonly verdict: Verdict
	readonly reason: string
}

export interface KneeRule {
	/** A step is past the knee when its checkout p95 is this many times the first step's. */
	readonly climb: number
	/** ... or when this share of its requests fail. */
	readonly errorRate: number
	/** A share of failed requests that means the store is breaking, which ends the test. */
	readonly breakRate: number
}

/**
 * Twice the first step's p95 is the climb, because the histograms bucket at
 * 25% steps and one bucket up is noise. One failure in a hundred is the knee;
 * one in twenty is the break.
 */
export const KNEE_RULE: KneeRule = { climb: 2, errorRate: 0.01, breakRate: 0.05 }

const rate = (step: StepOutcome): number =>
	step.requests === 0 ? 0 : step.failures / step.requests

const share = (value: number): string => `${(value * 100).toFixed(1)}%`

export const judge = (
	first: StepOutcome,
	step: StepOutcome,
	rule: KneeRule = KNEE_RULE,
): Judged => {
	const failed = rate(step)
	if (failed >= rule.breakRate)
		return { ...step, verdict: 'break', reason: `${share(failed)} of requests failed` }
	if (failed >= rule.errorRate)
		return { ...step, verdict: 'knee', reason: `${share(failed)} of requests failed` }
	if (
		first.checkoutP95 !== undefined &&
		step.checkoutP95 !== undefined &&
		step.checkoutP95 >= first.checkoutP95 * rule.climb
	)
		return {
			...step,
			verdict: 'knee',
			reason: `checkout p95 ${step.checkoutP95} ms, ${(step.checkoutP95 / first.checkoutP95).toFixed(1)} times the first step's ${first.checkoutP95} ms`,
		}
	return {
		...step,
		verdict: 'good',
		reason: `${share(failed)} failed, checkout p95 ${step.checkoutP95 ?? '-'} ms`,
	}
}

export interface StepPlan {
	readonly start: number
	/** The test gives up without a knee rather than go past this many users. */
	readonly most: number
	/** The bracket is narrow enough when its width is at most this share of the last good step. */
	readonly resolution: number
}

/** The next step's users, or why the test is over. */
export type Next = { readonly users: number } | { readonly done: string }

export const nextStep = (steps: readonly Judged[], plan: StepPlan): Next => {
	if (steps.length === 0) return { users: plan.start }
	const broke = steps.find(step => step.verdict === 'break')
	if (broke !== undefined) return { done: `stopped at ${broke.users} users: ${broke.reason}` }
	const good = steps.filter(step => step.verdict === 'good').map(step => step.users)
	const bad = steps.filter(step => step.verdict === 'knee').map(step => step.users)
	if (good.length === 0)
		return { done: `the first step, ${plan.start} users, was already past the knee` }
	const lastGood = Math.max(...good)
	if (bad.length === 0) {
		if (lastGood >= plan.most) return { done: `no knee up to ${plan.most} users` }
		return { users: Math.min(lastGood * 2, plan.most) }
	}
	const firstBad = Math.min(...bad)
	const width = firstBad - lastGood
	if (width <= Math.max(1, Math.ceil(lastGood * plan.resolution)))
		return { done: `the knee is between ${lastGood} and ${firstBad} users` }
	return { users: lastGood + Math.floor(width / 2) }
}

/** The bracket the test found: the last good step and the first bad one. */
export const kneeOf = (
	steps: readonly Judged[],
): { readonly lastGood?: Judged; readonly firstBad?: Judged } => {
	const good = steps.filter(step => step.verdict === 'good')
	const bad = steps.filter(step => step.verdict !== 'good')
	const lastGood = good.reduce<Judged | undefined>(
		(best, step) => (best === undefined || step.users > best.users ? step : best),
		undefined,
	)
	const firstBad = bad.reduce<Judged | undefined>(
		(best, step) => (best === undefined || step.users < best.users ? step : best),
		undefined,
	)
	return {
		...(lastGood === undefined ? {} : { lastGood }),
		...(firstBad === undefined ? {} : { firstBad }),
	}
}
