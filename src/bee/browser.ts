import { chromium, type Browser, type Page } from 'playwright'
import { LINE_TAG, Windows, type BeeEvent } from './lines.js'
import { readBeeConfig, type BeeConfig } from './config.js'

/**
 * The browser bee: one Chromium, several workers, each walking the store's
 * stages in a loop until the bee's own deadline. It records what a shopper's
 * browser measured, not what the server says, and writes a window of counts
 * every few seconds so a bee stopped early loses only its last one.
 */

const write = (line: object): void => {
	process.stdout.write(`${JSON.stringify(line)}\n`)
}

/** What the page's own navigation timing and paint observer saw. */
const measure = async (page: Page): Promise<{ ttfb?: number; total?: number; lcp?: number }> =>
	page.evaluate(async () => {
		const navigation = performance.getEntriesByType('navigation')[0] as
			PerformanceNavigationTiming | undefined
		const lcp = await new Promise<number>(resolve => {
			let latest = 0
			try {
				new PerformanceObserver(list => {
					for (const entry of list.getEntries()) latest = entry.startTime
				}).observe({ type: 'largest-contentful-paint', buffered: true })
			} catch {
				// A page with no paint to report still has its timing.
			}
			setTimeout(() => resolve(latest), 0)
		})
		if (navigation === undefined) return { lcp }
		return {
			ttfb: navigation.responseStart - navigation.requestStart,
			total: navigation.loadEventEnd - navigation.startTime,
			lcp,
		}
	})

const work = async (
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
	while (Date.now() < deadline) {
		const { stage, path } = config.paths[next] ?? { stage: 'home', path: '/' }
		next = (next + 1) % config.paths.length
		const remaining = deadline - Date.now()
		if (remaining < 1_000) break
		try {
			const response = await page.goto(new URL(path, config.url).href, {
				waitUntil: 'load',
				timeout: Math.min(30_000, remaining),
			})
			const timing = await measure(page)
			windows.add({
				stage,
				status: response?.status(),
				...(timing.ttfb !== undefined ? { ttfbMs: timing.ttfb } : {}),
				...(timing.total !== undefined ? { totalMs: timing.total } : {}),
				...(timing.lcp !== undefined ? { lcpMs: timing.lcp } : {}),
			})
		} catch {
			// A page that did not load in time is a failure of the store, counted, not a reason to stop.
			if (Date.now() < deadline) windows.add({ stage, status: undefined })
		}
	}
	await context.close()
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

	// Load is counted from here: starting Chromium is the bee's cost, not the store's.
	const browser = await chromium.launch()
	const deadline = Date.now() + config.seconds * 1_000
	write(event('started'))
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
