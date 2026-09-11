import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import type { DriftRecorder } from 'harness-kernel'
import { AssertionFailure, TransportFailure } from 'harness-kernel'

/** An ordered list of ways to find one thing, most portable first. */
export type Candidates = readonly string[]

/** Every element the storefront checks need, and how to find each. */
export type SelectorProfile = Readonly<Record<string, Candidates>>

export interface ResolveOptions {
	/** The entry names one control, so prefer a candidate matching exactly one visible element. */
	readonly unique?: boolean
	/** Answer only with a candidate matching something on screen, so an element hidden in the DOM reads as absent. */
	readonly visible?: boolean
	readonly timeoutMs?: number
}

export interface PageSession {
	readonly page: Page
	/** Resolves an entry of the profile; function-typed, because every check destructures it. */
	readonly find: (entry: string, options?: ResolveOptions) => Promise<Locator>
	/** True when the entry resolves; records the winner just the same. */
	readonly present: (entry: string, options?: ResolveOptions) => Promise<boolean>
}

/** What a check lends the browser: where to leave a recording, and when to give up. */
export interface Capture {
	/** The directory to write into, or undefined when the run is keeping none. */
	readonly dir: () => string | undefined
	/** Declares a file written, so the observation carries it. */
	readonly attach: (kind: string, absolutePath: string) => void
	/** Aborted at the check's time limit, which closes the context the check is waiting in. */
	readonly signal?: AbortSignal
}

/** How long one Playwright action or navigation may take when the call names no timeout. */
export const STEP_TIMEOUT_MS = 30_000

/** How long a call Playwright never times out itself may take: counting, evaluating, closing. */
export const UNTIMED_CALL_MS = 15_000

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
	/** Overrides STEP_TIMEOUT_MS. */
	readonly stepTimeoutMs?: number
	/** Overrides UNTIMED_CALL_MS. */
	readonly untimedCallMs?: number
}

/** A browser call that has no timeout of its own ran past the bound drexbot gives it. */
export class StepTimeout extends Error {
	override readonly name = 'StepTimeout'
}

/**
 * Bounds a Playwright call that carries no timeout of its own, so a page that
 * stops answering fails the step by name instead of waiting forever.
 */
export const within = async <T>(work: Promise<T>, ms: number, step: string): Promise<T> => {
	let timer: NodeJS.Timeout | undefined
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new StepTimeout(`${step} timed out after ${ms / 1_000}s`)), ms)
	})
	try {
		return await Promise.race([work, expired])
	} finally {
		clearTimeout(timer)
	}
}

interface Closable {
	close(): Promise<unknown>
}

/** The part of a browser context that closing it touches. */
export interface ClosableContext extends Closable {
	pages(): readonly Closable[]
}

/**
 * Closes every page and then the context, attempting each close even after one
 * stalls. Pages go first because `context.close()` exports the HAR before it
 * closes them, and that export waits on responses a cut-off navigation never finishes.
 */
export const closeInOrder = async (
	context: ClosableContext,
	boundMs: number,
): Promise<readonly StepTimeout[]> => {
	const stalls: StepTimeout[] = []
	const noteStall = (error: unknown): void => {
		if (error instanceof StepTimeout) stalls.push(error)
	}
	for (const page of context.pages()) {
		await within(page.close(), boundMs, 'closing the page').catch(noteStall)
	}
	await within(context.close(), boundMs, 'closing the browser context').catch(noteStall)
	return stalls
}

const firstLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''

/**
 * Reads whatever the page is telling the shopper, so a check that could not find
 * its entry reports the page's own explanation rather than only its absence.
 */
const describeMessages = async (
	page: Page,
	candidates: Candidates,
	boundMs: number,
): Promise<string> => {
	if (candidates.length === 0) return ''

	const reading = page.evaluate(
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
	const found = await within(reading, boundMs, "reading the page's messages").catch(
		() => [] as { severity: string; text: string }[],
	)

	return found.map(message => `${message.severity} — "${message.text}"`).join('; ')
}

/**
 * Reads the roles and names actually on the page when every candidate failed.
 * It is a proposal and nothing applies it.
 */
const describeInteractive = async (page: Page, boundMs: number): Promise<string> => {
	const reading = page.evaluate(() => {
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
	const found = await within(reading, boundMs, 'listing what is interactive').catch(
		() => [] as string[],
	)

	return found.length === 0 ? 'nothing visible and interactive was found' : found.join(', ')
}

/** The step a visit last started, so a check stopped at its time limit can say where it was. */
interface Whereabouts {
	step: string
}

/**
 * A real browser driven against a storefront, where every element is an ordered
 * candidate list and the winner is recorded.
 * @see README, "Selectors, and the ledger that watches them rot".
 */
export class BrowserSurface {
	private readonly stepTimeoutMs: number
	private readonly untimedCallMs: number

	private constructor(
		private readonly browser: Browser,
		private readonly options: BrowserOptions,
	) {
		this.stepTimeoutMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS
		this.untimedCallMs = options.untimedCallMs ?? UNTIMED_CALL_MS
	}

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
	async visit<T>(
		path: string,
		body: (session: PageSession) => Promise<T>,
		capture?: Capture,
	): Promise<T> {
		// Asked once, before anything is recorded: a run that is keeping no
		// evidence must not pay for a trace it is going to throw away.
		const dir = capture?.dir()
		const signal = capture?.signal
		const where: Whereabouts = { step: `opening ${path}` }
		let context: BrowserContext | undefined
		let closing: Promise<void> | undefined

		// Memoised, because the abort and the end of the visit both ask for it.
		const teardown = (failed: boolean): Promise<void> => {
			closing ??=
				context === undefined ? Promise.resolve() : this.teardown(context, dir, failed, capture)
			return closing
		}
		// Closing the context rejects the Playwright call the body is waiting in.
		const stop = (): void => {
			if (context !== undefined) void teardown(true).catch(() => undefined)
		}
		signal?.addEventListener('abort', stop, { once: true })

		let result: T
		try {
			context = await within(
				this.browser.newContext({
					viewport: this.options.viewport ?? { width: 1440, height: 900 },
					ignoreHTTPSErrors: false,
					...(dir === undefined
						? {}
						: {
								recordVideo: { dir: join(dir, 'video') },
								// Headers, statuses and timings without bodies. The trace already
								// carries the bodies for the action that failed, and a HAR that
								// embedded every image would be most of the budget.
								recordHar: { path: join(dir, 'network.har'), content: 'omit' },
							}),
				}),
				this.untimedCallMs,
				'opening a browser context',
			)
			if (signal?.aborted === true) throw signal.reason
			context.setDefaultTimeout(this.stepTimeoutMs)
			context.setDefaultNavigationTimeout(this.stepTimeoutMs)

			if (dir !== undefined) {
				await within(
					context.tracing.start({ screenshots: true, snapshots: true, sources: false }),
					this.untimedCallMs,
					'starting the trace',
				)
			}
			const page = await within(context.newPage(), this.untimedCallMs, 'opening a page')

			const response = await page.goto(`${this.options.baseUrl}${path}`, {
				waitUntil: 'domcontentloaded',
			})
			if (response !== null && response.status() >= 500) {
				throw new AssertionFailure(`${path} answered ${response.status()}`)
			}

			where.step = `on ${path}`
			result = await body(this.session(page, where))
		} catch (error) {
			signal?.removeEventListener('abort', stop)
			// The body's own error is the one worth reporting; a close that also
			// fails after it would only hide it.
			await teardown(true).catch(() => undefined)
			if (signal?.aborted === true) {
				throw new StepTimeout(`${where.step} — ${firstLine(error)}`)
			}
			throw error
		}

		signal?.removeEventListener('abort', stop)
		where.step = 'closing the browser context'
		await teardown(false)
		return result
	}

	/** Closes the context, keeping the recording only when the check failed. */
	private async teardown(
		context: BrowserContext,
		dir: string | undefined,
		failed: boolean,
		capture: Capture | undefined,
	): Promise<void> {
		const bound = this.untimedCallMs
		const trace = dir === undefined ? undefined : join(dir, 'trace.zip')
		if (trace !== undefined) {
			await within(context.tracing.stop(failed ? { path: trace } : {}), bound, 'saving the trace')
				.then(() => (failed ? capture?.attach('trace', trace) : undefined))
				.catch(() => undefined)
		}

		// Both are written by close(), so what they are worth is only decided
		// after it: the page is gone and the files are not there yet.
		const video = context.pages()[0]?.video() ?? null
		const stalls = await closeInOrder(context, bound)

		if (dir !== undefined) {
			const har = join(dir, 'network.har')
			if (failed) {
				capture?.attach('har', har)
				const savedTo =
					video === null
						? undefined
						: await within(video.path(), bound, 'finding the video').catch(() => undefined)
				if (savedTo !== undefined) capture?.attach('video', savedTo)
			} else {
				if (video !== null) {
					await within(video.delete(), bound, 'deleting the video').catch(() => undefined)
				}
				rmSync(har, { force: true })
			}
		}

		if (stalls[0] !== undefined) throw stalls[0]
	}

	async close(): Promise<void> {
		await within(this.browser.close(), this.untimedCallMs, 'closing the browser').catch(
			() => undefined,
		)
	}

	private session(page: Page, where: Whereabouts): PageSession {
		const find = async (entry: string, options: ResolveOptions = {}): Promise<Locator> => {
			where.step = `finding "${entry}"`
			const located = await this.resolve(page, entry, options)
			if (located !== null) {
				where.step = `using "${entry}"`
				return located
			}

			// What the page says about itself comes first: it is the higher-signal
			// half, and a storefront that has already explained the problem should
			// not be reported as a selector nobody can find.
			const saying = await describeMessages(page, this.options.messages ?? [], this.untimedCallMs)

			throw new AssertionFailure(
				`could not find "${entry}" on the page. Tried, in order:\n` +
					(this.options.profile[entry] ?? []).map(candidate => `  - ${candidate}`).join('\n') +
					(saying === '' ? '' : `\nThe page is saying: ${saying}`) +
					`\nWhat is visible and interactive: ${await describeInteractive(page, this.untimedCallMs)}`,
			)
		}

		return {
			page,
			find,
			present: async (entry, options = {}) => {
				where.step = `looking for "${entry}"`
				return (await this.resolve(page, entry, options)) !== null
			},
		}
	}

	/**
	 * How many elements a candidate matches. A selector the engine rejects counts
	 * as none, but a page that has stopped answering fails the step by name.
	 */
	private async count(located: Locator, entry: string, candidate: string): Promise<number> {
		return within(located.count(), this.untimedCallMs, `counting "${entry}" (${candidate})`).catch(
			(error: unknown) => {
				if (error instanceof StepTimeout) throw error
				return 0
			},
		)
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

		const locate = (candidate: string): Locator =>
			options.visible === true
				? page.locator(candidate).filter({ visible: true })
				: page.locator(candidate)

		// Wait once for any candidate, so auto-waiting still applies, then probe in
		// order — Playwright resolves a union in DOM order, which is not priority.
		const union = candidates
			.slice(1)
			.reduce((all, candidate) => all.or(locate(candidate)), locate(candidates[0] as string))

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
				if ((await this.count(visible, entry, candidate)) === 1) {
					this.options.recorder.record({ entry, index, candidate, candidates, matches: 1 })
					return visible
				}
			}
		}

		for (const [index, candidate] of candidates.entries()) {
			const located = locate(candidate)
			const matches = await this.count(located, entry, candidate)
			if (matches === 0) continue

			this.options.recorder.record({ entry, index, candidate, candidates, matches })
			return located
		}

		return null
	}
}
