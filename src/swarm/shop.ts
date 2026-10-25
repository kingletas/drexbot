import { parseInterval } from './orders.js'

/**
 * `drexbot swarm shop`: one run at the rate the time of day calls for. A timer
 * starts it every few minutes, so the store has customers ordering steadily
 * with no one starting runs; each run is one slice of that stream.
 */

export const DEFAULT_NIGHT_ORDERS = 25
export const DEFAULT_DAY_ORDERS = 5
export const DEFAULT_PER = '5m'

/** A stretch of the local day, in minutes since midnight; `from` is in it and `to` is not. */
export interface NightWindow {
	readonly from: number
	readonly to: number
}

const CLOCK = /^(\d{2}):(\d{2})$/

const minutesOf = (clock: string): number | undefined => {
	const match = CLOCK.exec(clock)
	const hours = Number(match?.[1])
	const minutes = Number(match?.[2])
	return match === null || hours > 23 || minutes > 59 ? undefined : hours * 60 + minutes
}

/** The window from `HH:MM-HH:MM`, or why it is not one. An end before the start crosses midnight. */
export const parseNight = (text: string): NightWindow | string => {
	const [from, to, ...extra] = text.split('-')
	const start = minutesOf(from ?? '')
	const end = minutesOf(to ?? '')
	if (start === undefined || end === undefined || extra.length > 0) {
		return `--night is HH:MM-HH:MM in local time, such as 01:00-05:00, not "${text}"`
	}
	if (start === end)
		return `--night "${text}" starts and ends at the same minute, so it holds no time`
	return { from: start, to: end }
}

/** Whether the local clock of `now` is inside the window, which may run across midnight. */
export const isNight = (window: NightWindow, now: Date): boolean => {
	const minute = now.getHours() * 60 + now.getMinutes()
	return window.from < window.to
		? minute >= window.from && minute < window.to
		: minute >= window.from || minute < window.to
}

/** How many orders the slice starting at `now` asks for: the night rate inside the window, the day rate outside it. */
export const ordersFor = (
	now: Date,
	window: NightWindow,
	rates: { readonly night: number; readonly day: number },
): number => (isNight(window, now) ? rates.night : rates.day)

/**
 * Seconds each slice leaves for starting its bee before the load and removing it
 * after, so the run is over before the timer's next tick: a tick that finds the
 * service still running starts nothing, and that slice is lost.
 */
export const SLICE_ROOM = 60

/** The flags `shop` reads for itself; everything else goes to `swarm run` untouched. */
const OWN_FLAGS = ['--night', '--night-orders', '--day-orders', '--per', '--seconds'] as const

export interface ShopRun {
	/** The arguments for `swarm run`. */
	readonly argv: readonly string[]
	readonly orders: number
	readonly night: boolean
	readonly perSeconds: number
	readonly per: string
	/** The seconds of load: the slice less SLICE_ROOM, unless `--seconds` made them shorter. */
	readonly seconds: number
}

/** The value after a flag, undefined when the flag is absent, or a refusal when it has none. */
const valueOf = (
	argv: readonly string[],
	name: string,
): string | undefined | { refusal: string } => {
	const index = argv.indexOf(name)
	if (index === -1) return undefined
	const value = argv[index + 1]
	return value === undefined || value.startsWith('--')
		? { refusal: `${name} needs a value` }
		: value
}

const orderCount = (
	argv: readonly string[],
	name: string,
	fallback: number,
): number | { refusal: string } => {
	const raw = valueOf(argv, name)
	if (typeof raw === 'object') return raw
	if (raw === undefined) return fallback
	const count = Number(raw)
	return Number.isInteger(count) && count >= 1
		? count
		: { refusal: `${name} needs a whole number of orders, 1 or more, not "${raw}"` }
}

/** `swarm run`'s arguments for the slice that starts at `now`, or the reason there cannot be one. */
export const shopRun = (argv: readonly string[], now: Date): ShopRun | string => {
	if (argv.includes('--orders')) {
		return 'swarm shop sets --orders itself, from the time of day; drop --orders'
	}
	const nightText = valueOf(argv, '--night')
	if (typeof nightText === 'object') return nightText.refusal
	if (nightText === undefined) {
		return 'swarm shop needs --night HH:MM-HH:MM, the local-time window that holds the daily deploy'
	}
	const window = parseNight(nightText)
	if (typeof window === 'string') return window

	const night = orderCount(argv, '--night-orders', DEFAULT_NIGHT_ORDERS)
	if (typeof night === 'object') return night.refusal
	const day = orderCount(argv, '--day-orders', DEFAULT_DAY_ORDERS)
	if (typeof day === 'object') return day.refusal
	const perText = valueOf(argv, '--per')
	if (typeof perText === 'object') return perText.refusal
	const per = perText ?? DEFAULT_PER
	const perSeconds = parseInterval(per)
	if (perSeconds === undefined) return `--per is a duration such as 5m, 90s or 1h, not "${per}"`

	const secondsText = valueOf(argv, '--seconds')
	if (typeof secondsText === 'object') return secondsText.refusal
	if (perSeconds < SLICE_ROOM + 10) {
		return `--per must be at least ${SLICE_ROOM + 10}s: each slice keeps ${SLICE_ROOM} seconds to start and remove its bee, and loads for 10 or more, not "${per}"`
	}
	const most = perSeconds - SLICE_ROOM
	const seconds = secondsText === undefined ? most : Number(secondsText)
	if (!Number.isInteger(seconds) || seconds < 10 || seconds > most) {
		return (
			`--seconds is the load of one slice: a whole number from 10 to ${most}, which leaves ` +
			`${SLICE_ROOM} seconds of the ${perSeconds}-second slice to start and remove the bee, not "${secondsText ?? most}"`
		)
	}

	const orders = ordersFor(now, window, { night, day })
	const rest: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ''
		if ((OWN_FLAGS as readonly string[]).includes(arg)) i++
		else rest.push(arg)
	}
	return {
		// The slice's orders are paced over its load, so every slice asks for exactly that many.
		argv: [
			...rest,
			'--orders',
			String(orders),
			'--per',
			`${seconds}s`,
			'--seconds',
			String(seconds),
		],
		orders,
		night: isNight(window, now),
		perSeconds,
		per,
		seconds,
	}
}
