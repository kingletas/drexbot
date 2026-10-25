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
	/** Time to first byte p95 over every request of the step. */
	readonly p95: number | undefined
	readonly requests: number
	readonly failures: number
	/** Requests the store answered a second. */
	readonly perSecond: number
}

export type Verdict = 'good' | 'knee' | 'break'

export interface Judged extends StepOutcome {
	readonly verdict: Verdict
	readonly reason: string
}

export interface KneeRule {
	/** Past the knee when the store answers less than this share of the extra load the extra users asked for. */
	readonly scaling: number
	/** ... or when a p95, of every request or of checkout, is this many times the first step's. */
	readonly climb: number
	/** ... or when this share of its requests fail. */
	readonly errorRate: number
	/** A share of failed requests that means the store is breaking, which ends the test. */
	readonly breakRate: number
}

/**
 * The knee is where more users stop buying more answers: throughput that rises
 * less than half as fast as the users asked for it. Twice the first step's p95
 * also counts, twice because the histograms bucket at 25% steps and one bucket
 * up is noise. One failure in a hundred is the knee; one in twenty is the break.
 */
export const KNEE_RULE: KneeRule = { scaling: 0.5, climb: 2, errorRate: 0.01, breakRate: 0.05 }

const rate = (step: StepOutcome): number =>
	step.requests === 0 ? 0 : step.failures / step.requests

const share = (value: number): string => `${(value * 100).toFixed(1)}%`

const times = (now: number, before: number): string => (now / before).toFixed(1)

/**
 * A step judged against the steps before it: the first step, for latency, and
 * the nearest good step with fewer users, for whether the extra users bought
 * extra answers.
 */
export const judge = (
	before: readonly Judged[],
	step: StepOutcome,
	rule: KneeRule = KNEE_RULE,
): Judged => {
	const failed = rate(step)
	const verdict = (v: Verdict, reason: string): Judged => ({ ...step, verdict: v, reason })
	if (failed >= rule.breakRate) return verdict('break', `${share(failed)} of requests failed`)
	if (failed >= rule.errorRate) return verdict('knee', `${share(failed)} of requests failed`)
	const below = before
		.filter(other => other.verdict === 'good' && other.users < step.users)
		.reduce<Judged | undefined>(
			(best, other) => (best === undefined || other.users > best.users ? other : best),
			undefined,
		)
	if (below !== undefined && below.perSecond > 0) {
		const asked = step.users / below.users - 1
		const got = step.perSecond / below.perSecond - 1
		if (got < asked * rule.scaling)
			return verdict(
				'knee',
				`${Math.round(asked * 100)}% more users than ${below.users} bought ${Math.round(got * 100)}% more answers ` +
					`(${step.perSecond} a second against ${below.perSecond})`,
			)
	}
	const first = [...before, step].reduce((low, other) => (other.users < low.users ? other : low))
	if (first.p95 !== undefined && step.p95 !== undefined && step.p95 >= first.p95 * rule.climb)
		return verdict(
			'knee',
			`p95 of every request ${step.p95} ms, ${times(step.p95, first.p95)} times the first step's ${first.p95} ms`,
		)
	if (
		first.checkoutP95 !== undefined &&
		step.checkoutP95 !== undefined &&
		step.checkoutP95 >= first.checkoutP95 * rule.climb
	)
		return verdict(
			'knee',
			`checkout p95 ${step.checkoutP95} ms, ${times(step.checkoutP95, first.checkoutP95)} times the first step's ${first.checkoutP95} ms`,
		)
	return verdict(
		'good',
		`${step.perSecond} a second, p95 ${step.p95 ?? '-'} ms, checkout p95 ${step.checkoutP95 ?? '-'} ms, ${share(failed)} failed`,
	)
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
export const kneeOf = <T extends Judged>(
	steps: readonly T[],
): { readonly lastGood?: T; readonly firstBad?: T } => {
	const good = steps.filter(step => step.verdict === 'good')
	const bad = steps.filter(step => step.verdict !== 'good')
	const lastGood = good.reduce<T | undefined>(
		(best, step) => (best === undefined || step.users > best.users ? step : best),
		undefined,
	)
	const firstBad = bad.reduce<T | undefined>(
		(best, step) => (best === undefined || step.users < best.users ? step : best),
		undefined,
	)
	return {
		...(lastGood === undefined ? {} : { lastGood }),
		...(firstBad === undefined ? {} : { firstBad }),
	}
}

/** A capped service and the mean share of its cap it used during a step. */
export interface Capped {
	readonly service: string
	readonly capCpus: number
	readonly share: number
}

/** One step as it ran: its verdict, the orders it placed, and the store and machine under it. */
export interface StepTaken extends Judged {
	readonly run: string
	readonly seconds: number
	readonly ordersPlaced: number
	/** Capped services, busiest first. */
	readonly capped: readonly Capped[]
	/** The machine's mean one-minute load over its cores. */
	readonly machineLoad: number
}

/** Above this the machine, not the store, may be what a bad step measured. */
export const MACHINE_BUSY = 0.75

const pct = (value: number): string => `${Math.round(value * 100)}%`

const busiest = (step: StepTaken): string => {
	const top = step.capped[0]
	return top === undefined ? '-' : `${top.service} ${pct(top.share)} of ${top.capCpus} CPU`
}

/**
 * The step test as a person reads it: each step, then the knee as ratios
 * against the store's caps, with the caps beside them and the service that
 * gave first. Users per step say how the load was set; the result is never a
 * count of shoppers, which means nothing for a store with other caps.
 */
export const renderStepTest = (
	steps: readonly StepTaken[],
	done: string,
	options: { readonly target: string; readonly mix: string; readonly workers?: number },
): string => {
	const out = [
		'',
		`  step test against ${options.target}, mix ${options.mix}, ${steps[0]?.seconds ?? 0}s a step`,
		`    ${'users'.padEnd(6)} ${'verdict'.padEnd(8)} ${'a second'.padEnd(9)} ${'p95'.padEnd(9)} ${'checkout p95'.padEnd(13)} ${'failed'.padEnd(7)} ${'busiest service'.padEnd(26)} machine`,
	]
	for (const step of [...steps].sort((a, b) => a.users - b.users)) {
		out.push(
			`    ${String(step.users).padEnd(6)} ${step.verdict.padEnd(8)} ${String(step.perSecond).padEnd(9)} ` +
				`${(step.p95 === undefined ? '-' : `${step.p95} ms`).padEnd(9)} ` +
				`${(step.checkoutP95 === undefined ? '-' : `${step.checkoutP95} ms`).padEnd(13)} ` +
				`${(step.requests === 0 ? '-' : `${((step.failures / step.requests) * 100).toFixed(1)}%`).padEnd(7)} ` +
				`${busiest(step).padEnd(26)} ${pct(step.machineLoad)}`,
		)
	}
	out.push('', `  ${done}`)
	const { lastGood, firstBad } = kneeOf(steps)
	const caps = (lastGood ?? firstBad)?.capped ?? []
	if (lastGood !== undefined && caps.length > 0) {
		const storeCpus = caps.reduce((sum, cap) => sum + cap.capCpus, 0)
		const minutes = lastGood.seconds / 60
		const perMinute = lastGood.ordersPlaced / minutes
		const app = caps.find(cap => cap.service === 'php')
		out.push(
			`  at the last good step: ${(perMinute / storeCpus).toFixed(2)} orders a minute per store CPU` +
				(app === undefined ? '' : `, ${(perMinute / app.capCpus).toFixed(2)} per PHP CPU`) +
				(options.workers === undefined
					? ''
					: `, ${(perMinute / options.workers).toFixed(2)} per PHP-FPM worker`) +
				`; ${(lastGood.requests / lastGood.seconds / storeCpus).toFixed(1)} requests a second per store CPU`,
		)
	}
	if (firstBad !== undefined) {
		out.push(
			`  gives first: ${busiest(firstBad)} at the first bad step` +
				(lastGood === undefined ? '' : `, ${busiest(lastGood)} at the last good one`),
		)
	}
	if (caps.length > 0) {
		out.push(
			`  the store's caps: ${[...caps]
				.sort((a, b) => a.service.localeCompare(b.service))
				.map(cap => `${cap.service} ${cap.capCpus}`)
				.join(', ')} CPU` +
				(options.workers === undefined ? '' : `; ${options.workers} PHP-FPM workers`),
		)
	}
	const busy = steps.filter(step => step.machineLoad >= MACHINE_BUSY)
	out.push(
		busy.length === 0
			? `  the machine stayed under ${pct(MACHINE_BUSY)} load at every step, so the knee is the store's`
			: `  the machine passed ${pct(MACHINE_BUSY)} load at ${busy.map(step => step.users).join(', ')} users: those steps may measure the machine, not the store`,
	)
	return `${out.join('\n')}\n`
}
