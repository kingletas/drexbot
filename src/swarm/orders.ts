import type { Shape } from './plan.js'

/**
 * Orders at a set rate: `--orders N --per DURATION` makes one protocol bee place
 * N orders in every DURATION, evenly, whatever the store does meanwhile.
 */

export type Orders = NonNullable<Shape['orders']>

/** Shorter than this and an order, which is five requests, cannot be told from the rate. */
export const SHORTEST_INTERVAL = 10

const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 }

/** Seconds in a duration such as `60s`, `5m` or `1h`, or undefined when it is not one. */
export const parseInterval = (text: string): number | undefined => {
	const match = /^(\d+)([smh])$/.exec(text)
	const unit = UNIT_SECONDS[match?.[2] ?? '']
	return match === null || unit === undefined ? undefined : Number(match[1]) * unit
}

/** A number of seconds as the largest unit that holds it whole: 300 is `5m`. */
export const intervalText = (seconds: number): string =>
	seconds % 3600 === 0
		? `${seconds / 3600}h`
		: seconds % 60 === 0
			? `${seconds / 60}m`
			: `${seconds}s`

/** The orders a run asks for in its length: N for every whole or part interval, rounded down. */
export const ordersAskedFor = (orders: Orders, seconds: number): number =>
	Math.floor((orders.count * seconds) / orders.perSeconds)

/**
 * The seconds an order is allowed before the bee counts on another user for the
 * next one. A checkout is five requests that normally take a few seconds, and
 * each is cut off at 30, so a minute is generous.
 */
export const ORDER_SECONDS = 60

/**
 * The k6 users an order rate needs. The pre-allocated ones are those a rate
 * keeps busy when every order takes ORDER_SECONDS (orders per second times that,
 * by Little's law); twice as many are allowed before k6 drops an order, so a slow
 * store is shown as dropped orders rather than answered with ever more users.
 * bees/protocol/bee.js repeats this, and a test holds the two equal.
 */
export const orderUsers = (orders: Orders): { readonly start: number; readonly most: number } => {
	const start = Math.max(1, Math.ceil((orders.count / orders.perSeconds) * ORDER_SECONDS))
	return { start, most: start * 2 }
}

const valueAfter = (argv: readonly string[], name: string): string | undefined => {
	const index = argv.indexOf(name)
	return index === -1 ? undefined : (argv[index + 1] ?? '')
}

/**
 * The rate the flags ask for: undefined when they ask for none, and otherwise
 * the rate, or the sentence that says what to change.
 */
export const ordersFrom = (argv: readonly string[]): Orders | string | undefined => {
	const has = (name: string): boolean => argv.includes(name)
	if (!has('--orders') && !has('--per')) return undefined
	if (!has('--per')) {
		return '--orders needs --per, the time those orders are spread over: --orders 5 --per 5m'
	}
	if (!has('--orders')) {
		return '--per needs --orders, how many orders to place in that time: --orders 5 --per 5m'
	}
	const rawCount = valueAfter(argv, '--orders') ?? ''
	const count = /^\d+$/.test(rawCount) ? Number(rawCount) : 0
	if (!Number.isSafeInteger(count) || count < 1) {
		return `--orders needs a whole number of orders above 0, not "${rawCount}"`
	}
	const rawPer = valueAfter(argv, '--per') ?? ''
	const perSeconds = parseInterval(rawPer)
	if (perSeconds === undefined) {
		return `--per needs a duration such as 60s, 5m or 1h, not "${rawPer}"`
	}
	if (perSeconds < SHORTEST_INTERVAL) {
		return `--per ${rawPer} is under ${SHORTEST_INTERVAL} seconds, too short to pace orders by; use ${SHORTEST_INTERVAL}s or more`
	}
	if (has('--mix')) {
		return '--orders paces the orders itself and cannot be used with --mix; leave --mix out'
	}
	if (has('--protocol-users')) {
		return '--orders sizes the protocol bee from the rate and cannot be used with --protocol-users; leave --protocol-users out'
	}
	return { count, perSeconds }
}
