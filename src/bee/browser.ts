import { chromium, type Browser, type Page } from 'playwright'
import { addToCart, placeOrder, StepFailed } from './checkout.js'
import { failed, JOURNEY_PREFIX, LINE_TAG, Windows, type BeeEvent } from './lines.js'
import { journeyFor, MIXES } from './mix.js'
import { readBeeConfig, type BeeConfig } from './config.js'
import { measure } from './timing.js'

/**
 * The browser bee: one Chromium, several workers, each walking the store's
 * stages in a loop until the bee's own deadline. It records what a shopper's
 * browser measured, not what the server says, and writes a window of counts
 * every few seconds so a bee stopped early loses only its last one.
 */

const write = (line: object): void => {
	process.stdout.write(`${JSON.stringify(line)}\n`)
}

/** Loads one page as a stage and records it; returns its status, undefined when it did not load. */
const visit = async (
	page: Page,
	config: BeeConfig,
	stage: string,
	path: string,
	deadline: number,
	windows: Windows,
): Promise<number | undefined> => {
	try {
		const response = await page.goto(new URL(path, config.url).href, {
			waitUntil: 'load',
			timeout: Math.min(30_000, Math.max(1_000, deadline - Date.now())),
		})
		const timing = await measure(page)
		const status = response?.status()
		windows.add({
			stage,
			status,
			...(timing.ttfb !== undefined ? { ttfbMs: timing.ttfb } : {}),
			...(timing.total !== undefined ? { totalMs: timing.total } : {}),
			...(timing.lcp !== undefined ? { lcpMs: timing.lcp } : {}),
		})
		return status
	} catch {
		// A page that did not load in time is a failure of the store, counted, not a reason to stop.
		if (Date.now() < deadline) windows.add({ stage, status: undefined })
		return undefined
	}
}

/** Walks the stages one page at a time in one long-lived browser: the bee without a mix. */
const browse = async (
	browser: Browser,
	config: BeeConfig,
	deadline: number,
	windows: Windows,
	worker: number,
): Promise<void> => {
	const context = await browser.newContext()
	const page = await context.newPage()
	// Workers start on different stages, so they are not all asking for one page at once.
	let next = worker % config.paths.length
	while (deadline - Date.now() >= 1_000) {
		const { stage, path } = config.paths[next] ?? { stage: 'home', path: '/' }
		next = (next + 1) % config.paths.length
		await visit(page, config, stage, path, deadline, windows)
	}
	await context.close()
}

/**
 * A checkout journey started with less than this left would be cut off by the
 * bee's own deadline and counted as the store failing.
 */
const JOURNEY_ROOM_MS = 60_000

/**
 * One new shopper per journey, each in a fresh browser context so every cart
 * starts empty, drawn from the mix. A journey's own sample carries the status
 * its last step ended on, or none when any step failed.
 */
const shop = async (
	browser: Browser,
	config: BeeConfig,
	deadline: number,
	windows: Windows,
	worker: number,
): Promise<void> => {
	const record = windows.add.bind(windows)
	let offset = worker % config.paths.length
	while (deadline - Date.now() >= 1_000) {
		const journey = journeyFor(MIXES[config.mix], Math.random())
		if (journey !== 'browse' && deadline - Date.now() < JOURNEY_ROOM_MS) break
		const context = await browser.newContext()
		const page = await context.newPage()
		const started = performance.now()
		let status: number | undefined
		let served = true
		try {
			if (journey === 'browse') {
				for (let i = 0; i < config.paths.length && deadline - Date.now() >= 1_000; i++) {
					const { stage, path } = config.paths[(offset + i) % config.paths.length] ?? {
						stage: 'home',
						path: '/',
					}
					status = await visit(page, config, stage, path, deadline, windows)
					if (failed(status)) served = false
				}
				offset = (offset + 1) % config.paths.length
			} else {
				status = await visit(page, config, 'product', config.cartPath ?? '/', deadline, windows)
				if (failed(status)) throw new StepFailed('the product page did not load')
				status = await addToCart(page, record)
				if (journey === 'order') status = await placeOrder(page, config.url, record)
			}
		} catch {
			// The step that failed has recorded itself; the journey only counts as not served.
			served = false
		} finally {
			await context.close()
		}
		windows.add({
			stage: `${JOURNEY_PREFIX}${journey}`,
			status: served ? status : undefined,
			totalMs: performance.now() - started,
		})
	}
}

const main = async (): Promise<number> => {
	const config = readBeeConfig(process.env)
	const identity = { run: config.run, bee: config.bee, kind: 'browser' as const }
	const windows = new Windows(identity)
	const event = (name: BeeEvent['event'], note?: string): BeeEvent => ({
		drexbot: LINE_TAG,
		event: name,
		...identity,
		at: new Date().toISOString(),
		concurrency: config.concurrency,
		...(note !== undefined ? { note } : {}),
	})
	const work = config.mix === 'browse' ? browse : shop

	// Load is counted from here: starting Chromium is the bee's cost, not the store's.
	const browser = await chromium.launch()
	const deadline = Date.now() + config.seconds * 1_000
	write(event('started', config.mix === 'browse' ? undefined : `mix ${config.mix}`))
	const flusher = setInterval(() => windows.flush().forEach(write), config.windowSeconds * 1_000)
	try {
		await Promise.all(
			Array.from({ length: config.concurrency }, (_, worker) =>
				work(browser, config, deadline, windows, worker),
			),
		)
	} finally {
		clearInterval(flusher)
		windows.flush().forEach(write)
		await browser.close()
	}
	write(event('finished'))
	return 0
}

main().then(
	code => (process.exitCode = code),
	(cause: unknown) => {
		process.stderr.write(`browser bee: ${cause instanceof Error ? cause.message : String(cause)}\n`)
		process.exitCode = 1
	},
)
