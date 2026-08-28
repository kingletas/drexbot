import { DriftRecorder } from '@harness/kernel'
import type { ProbeFinding, ProbeReport } from '@harness/kernel'
import { BrowserSurface, type PageSession } from '../surfaces/browser.js'
import { LUMA_PROFILE } from './selectors.js'

/** One stop on the walk, and the entries worth asking for once you are there. */
interface Stage {
	readonly name: string
	readonly entries: readonly string[]
}

const STAGES: readonly Stage[] = [
	{ name: 'home', entries: ['searchInput', 'searchSubmit', 'minicartToggle'] },
	{ name: 'search results', entries: ['pageTitle', 'productTile', 'productLink'] },
	{ name: 'category', entries: ['pageTitle', 'productTile', 'productLink', 'productPrice'] },
	{
		name: 'product',
		entries: ['pageTitle', 'productPrice', 'addToCart', 'sizeOption', 'colourOption'],
	},
	{ name: 'after add to cart', entries: ['successMessage', 'minicartCounter'] },
]

export interface ProbeOptions {
	/** Where to look for a listing. Baselined per store rather than assumed. */
	readonly categoryPath: string
	readonly searchTerm: string
	/** How long to wait for each entry; a site the suite cannot drive waits it out once each. */
	readonly timeoutMs?: number
}

/**
 * Walks the journey and reports what resolved, asserting nothing and writing
 * nothing: no payment, no order, and no account.
 */
export const probeStorefront = async (
	baseUrl: string,
	options: ProbeOptions,
): Promise<ProbeReport> => {
	const findings: ProbeFinding[] = []
	const unreached: { stage: string; why: string }[] = []

	// Its own browser and its own recorder. The probe asks the same entry on
	// several pages, so it needs each resolution as it happens rather than the
	// best one the run managed anywhere.
	const recorder = new DriftRecorder()
	const surface = await BrowserSurface.launch({ baseUrl, profile: LUMA_PROFILE, recorder })

	const ask = async (
		session: PageSession,
		stage: string,
		entries: readonly string[],
	): Promise<void> => {
		for (const entry of entries) {
			recorder.drain()
			const found = await session
				.present(entry, { timeoutMs: options.timeoutMs ?? 4_000 })
				.catch(() => false)
			const won = recorder.drain().at(-1)

			findings.push({
				stage,
				entry,
				resolved: found,
				via: found ? (won?.candidate ?? 'matched') : 'NO MATCH',
				...(won === undefined ? {} : { index: won.index }),
				of: LUMA_PROFILE[entry]?.length ?? 0,
				matches: won?.matches ?? 0,
			})
		}
	}

	const wait = options.timeoutMs ?? 4_000

	const walk = async (
		stage: Stage,
		path: string,
		before?: (session: PageSession) => Promise<void>,
	) => {
		try {
			await surface.visit(path, async session => {
				await before?.(session)
				await ask(session, stage.name, stage.entries)
			})
		} catch (cause) {
			unreached.push({
				stage: stage.name,
				why: cause instanceof Error ? (cause.message.split('\n')[0] ?? 'unknown') : String(cause),
			})
		}
	}

	await walk(STAGES[0] as Stage, '/')

	await walk(
		STAGES[1] as Stage,
		`/catalogsearch/result/?q=${encodeURIComponent(options.searchTerm)}`,
	)

	await walk(STAGES[2] as Stage, options.categoryPath)

	await walk(STAGES[3] as Stage, options.categoryPath, async ({ page, find }) => {
		await (await find('productLink', { timeoutMs: wait })).first().click()
		await page.waitForLoadState('domcontentloaded')
	})

	await walk(STAGES[4] as Stage, options.categoryPath, async ({ page, find, present }) => {
		await (await find('productLink', { timeoutMs: wait })).first().click()
		await page.waitForLoadState('domcontentloaded')

		for (const option of ['sizeOption', 'colourOption'] as const) {
			if (await present(option, { timeoutMs: wait })) {
				await (await find(option, { timeoutMs: wait })).first().click()
			}
		}
		await (await find('addToCart', { unique: true, timeoutMs: wait })).click()
		await page.waitForTimeout(2_000)
	})

	await surface.close()
	return { target: 'magento', baseUrl, findings, unreached }
}
