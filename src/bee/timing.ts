import type { Page } from 'playwright'

/** What the page's own navigation timing and paint observer saw. */
export const measure = async (
	page: Page,
): Promise<{ ttfb?: number; total?: number; lcp?: number }> =>
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
