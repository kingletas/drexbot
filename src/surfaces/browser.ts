import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import type { DriftRecorder } from '@harness/kernel'
import { AssertionFailure, TransportFailure } from '@harness/kernel'

/** An ordered list of ways to find one thing, most portable first. */
export type Candidates = readonly string[]

/** Every element the storefront checks need, and how to find each. */
export type SelectorProfile = Readonly<Record<string, Candidates>>

export interface ResolveOptions {
	/** The entry names one control, so prefer a candidate matching exactly one visible element. */
	readonly unique?: boolean
	readonly timeoutMs?: number
}

export interface PageSession {
	readonly page: Page
	/** Resolves an entry of the profile; function-typed, because every check destructures it. */
	readonly find: (entry: string, options?: ResolveOptions) => Promise<Locator>
	/** True when the entry resolves; records the winner just the same. */
	readonly present: (entry: string, options?: ResolveOptions) => Promise<boolean>
}

export interface BrowserOptions {
	readonly baseUrl: string
	readonly profile: SelectorProfile
	/**
	 * How this platform renders a message to the shopper, most portable first.
	 * Declared apart from the profile because it is read only when something has
	 * already failed, and never through the drift ledger.
	 */
	readonly messages?: Candidates
	readonly recorder: DriftRecorder
	readonly headless?: boolean
	readonly viewport?: { readonly width: number; readonly height: number }
}

/**
 * Reads whatever the page is telling the shopper, so a check that could not find
 * its entry reports the page's own explanation rather than only its absence.
 */
const describeMessages = async (page: Page, candidates: Candidates): Promise<string> => {
	if (candidates.length === 0) return ''

	const found = await page
		.evaluate(
			selectors => {
				const seen = new Set<Element>()
				const out: { severity: string; text: string }[] = []

				for (const selector of selectors) {
					for (const element of document.querySelectorAll(selector)) {
						if (seen.has(element) || (element as HTMLElement).offsetParent === null) continue
						seen.add(element)

						const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ')
						if (text === '') continue

						const marker = `${element.getAttribute('data-ui-id') ?? ''} ${String((element as HTMLElement).className ?? '')}`
						const severity = /error/.test(marker)
							? 'error'
							: /warning/.test(marker)
								? 'warning'
								: /success/.test(marker)
									? 'success'
									: /notice/.test(marker)
										? 'notice'
										: 'message'
						out.push({ severity, text: text.slice(0, 160) })
					}
				}
				return out.slice(0, 4)
			},
			[...candidates],
		)
		.catch(() => [] as { severity: string; text: string }[])

	return found.map(message => `${message.severity} — "${message.text}"`).join('; ')
}

/**
 * Reads the roles and names actually on the page when every candidate failed.
 * It is a proposal and nothing applies it.
 */
const describeInteractive = async (page: Page): Promise<string> => {
	const found = await page
		.evaluate(() => {
			const interesting = 'button, a[href], input, select, [role="button"], [role="link"]'
			return [...document.querySelectorAll(interesting)]
				.filter(element => (element as HTMLElement).offsetParent !== null)
				.slice(0, 12)
				.map(element => {
					const tag = element.tagName.toLowerCase()
					const name = (element.getAttribute('aria-label') ?? element.textContent ?? '')
						.trim()
						.replace(/\s+/g, ' ')
						.slice(0, 40)
					const id = element.id ? `#${element.id}` : ''
					return `${tag}${id} "${name}"`
				})
		})
		.catch(() => [] as string[])

	return found.length === 0 ? 'nothing visible and interactive was found' : found.join(', ')
}

/**
 * A real browser driven against a storefront, where every element is an ordered
 * candidate list and the winner is recorded.
 * @see README, "Selectors, and the ledger that watches them rot".
 */
export class BrowserSurface {
	private constructor(
		private readonly browser: Browser,
		private readonly options: BrowserOptions,
	) {}

	static async launch(options: BrowserOptions): Promise<BrowserSurface> {
		try {
			const browser = await chromium.launch({ headless: options.headless ?? true })
			return new BrowserSurface(browser, options)
		} catch (cause) {
			throw new TransportFailure(
				`could not start a browser: ${cause instanceof Error ? cause.message : String(cause)}`,
			)
		}
	}

	/**
	 * Runs one body in its own context and always tears it down, because a check
	 * that inherits another's cookies is not testing what its name says.
	 */
	async visit<T>(path: string, body: (session: PageSession) => Promise<T>): Promise<T> {
		let context: BrowserContext | undefined

		try {
			context = await this.browser.newContext({
				viewport: this.options.viewport ?? { width: 1440, height: 900 },
				ignoreHTTPSErrors: false,
			})
			const page = await context.newPage()

			const response = await page.goto(`${this.options.baseUrl}${path}`, {
				waitUntil: 'domcontentloaded',
				timeout: 30_000,
			})
			if (response !== null && response.status() >= 500) {
				throw new AssertionFailure(`${path} answered ${response.status()}`)
			}

			return await body(this.session(page))
		} finally {
			await context?.close().catch(() => undefined)
		}
	}

	async close(): Promise<void> {
		await this.browser.close().catch(() => undefined)
	}

	private session(page: Page): PageSession {
		const find = async (entry: string, options: ResolveOptions = {}): Promise<Locator> => {
			const located = await this.resolve(page, entry, options)
			if (located !== null) return located

			// What the page says about itself comes first: it is the higher-signal
			// half, and a storefront that has already explained the problem should
			// not be reported as a selector nobody can find.
			const saying = await describeMessages(page, this.options.messages ?? [])

			throw new AssertionFailure(
				`could not find "${entry}" on the page. Tried, in order:\n` +
					(this.options.profile[entry] ?? []).map(candidate => `  - ${candidate}`).join('\n') +
					(saying === '' ? '' : `\nThe page is saying: ${saying}`) +
					`\nWhat is visible and interactive: ${await describeInteractive(page)}`,
			)
		}

		return {
			page,
			find,
			present: async (entry, options = {}) => (await this.resolve(page, entry, options)) !== null,
		}
	}

	private async resolve(
		page: Page,
		entry: string,
		options: ResolveOptions,
	): Promise<Locator | null> {
		const candidates = this.options.profile[entry]
		if (candidates === undefined || candidates.length === 0) {
			throw new AssertionFailure(`the selector profile has no entry named "${entry}"`)
		}

		// Wait once for any candidate, so auto-waiting still applies, then probe in
		// order — Playwright resolves a union in DOM order, which is not priority.
		const union = candidates
			.slice(1)
			.reduce(
				(all, candidate) => all.or(page.locator(candidate)),
				page.locator(candidates[0] as string),
			)

		await union
			.first()
			.waitFor({ state: 'visible', timeout: options.timeoutMs ?? 10_000 })
			.catch(() => undefined)

		if (options.unique === true) {
			// A candidate can match one element that happens to be hidden — a sticky
			// footer's duplicate of a button, say — and returning it strands every
			// later action on something that can never be clicked.
			for (const [index, candidate] of candidates.entries()) {
				const visible = page.locator(candidate).filter({ visible: true })
				if ((await visible.count().catch(() => 0)) === 1) {
					this.options.recorder.record({ entry, index, candidate, candidates, matches: 1 })
					return visible
				}
			}
		}

		for (const [index, candidate] of candidates.entries()) {
			const located = page.locator(candidate)
			const matches = await located.count().catch(() => 0)
			if (matches === 0) continue

			this.options.recorder.record({ entry, index, candidate, candidates, matches })
			return located
		}

		return null
	}
}
