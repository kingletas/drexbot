import type { CheckDefinition } from '@harness/kernel'
import { AssertionFailure, PreconditionFailure } from '@harness/kernel'
import type { BrowserSurface } from '../surfaces/browser.js'
import { NO_BASELINE, type StoreBaseline } from './baseline.js'

/**
 * What a shopper actually does, in a real browser because the thing tested is
 * the rendered page. Nothing here writes to the store.
 */
export const journeyChecks = (
	browser: () => Promise<BrowserSurface>,
	store: StoreBaseline,
): readonly CheckDefinition[] => [
	{
		id: 'magento.journey.search',
		area: 'search',
		title: 'A shopper can search and get results',
		suite: 'journey',
		needs: ['browser'],
		async body({ record, measure }) {
			if (!store.captured) throw new PreconditionFailure(NO_BASELINE)
			const surface = await browser()

			await surface.visit('/', async ({ page, find }) => {
				const started = Date.now()

				await (await find('searchInput', { unique: true })).fill(store.searchTerm)
				await page.keyboard.press('Enter')
				await page.waitForLoadState('domcontentloaded')

				measure({ name: 'search', value: Date.now() - started, unit: 'ms', stage: 'results' })

				const title = await (await find('pageTitle')).first().innerText()
				record('results page', title.trim())

				const tiles = await (await find('productTile')).count()
				record('products shown', String(tiles))

				if (tiles === 0) {
					throw new AssertionFailure(
						`a search for "${store.searchTerm}" rendered a results page with no products`,
					)
				}
			})
		},
	},
	{
		id: 'magento.journey.product-page',
		area: 'product',
		title: 'A product page renders a price and a way to buy',
		suite: 'journey',
		needs: ['browser'],
		async body({ record, measure }) {
			if (!store.captured) throw new PreconditionFailure(NO_BASELINE)
			const surface = await browser()

			await surface.visit(store.categoryPath, async ({ page, find }) => {
				await (await find('productLink')).first().click()
				await page.waitForLoadState('domcontentloaded')

				const started = Date.now()
				const title = await (await find('pageTitle')).first().innerText()
				record('product', title.trim())

				const price = await (await find('productPrice')).first().innerText()
				record('price', price.trim())
				measure({ name: 'product page', value: Date.now() - started, unit: 'ms', stage: 'pdp' })

				// Sampled once, this races the product form's own initialisation. What
				// the shopper needs is that the button *becomes* usable, so that is asked.
				const buy = await find('addToCart', { unique: true })
				try {
					await buy.first().waitFor({ state: 'visible', timeout: 15_000 })
					await page.waitForFunction(
						element => !(element as HTMLButtonElement).disabled,
						await buy.first().elementHandle(),
						{ timeout: 15_000 },
					)
				} catch {
					throw new AssertionFailure(
						`"${title.trim()}" renders an add-to-cart button that never became enabled`,
					)
				}
			})
		},
	},
	{
		id: 'magento.journey.add-to-cart',
		area: 'cart',
		title: 'A product can be added to the cart',
		suite: 'journey',
		needs: ['browser'],
		async body({ record }) {
			if (!store.captured) throw new PreconditionFailure(NO_BASELINE)
			const surface = await browser()

			await surface.visit(store.categoryPath, async ({ page, find, present }) => {
				await (await find('productLink')).first().click()
				await page.waitForLoadState('domcontentloaded')

				// A configurable product refuses to go in the cart until every option
				// is chosen, so the swatches are part of the journey rather than
				// decoration. A simple product has none, and skipping them is correct.
				for (const option of ['sizeOption', 'colourOption'] as const) {
					if (await present(option)) {
						await (await find(option)).first().click()
					}
				}

				await (await find('addToCart', { unique: true })).click()

				const success = await find('successMessage', { timeoutMs: 20_000 })
				const message = await success.first().innerText()
				record('confirmation', message.trim().replace(/\s+/g, ' ').slice(0, 120))

				if (!/added|cart/i.test(message)) {
					throw new AssertionFailure(`adding to the cart reported "${message.trim()}"`)
				}

				const counter = await find('minicartCounter')
				const shown = (await counter.first().innerText()).trim()
				record('minicart count', shown === '' ? 'blank' : shown)

				if (shown === '' || shown === '0') {
					throw new AssertionFailure(
						`the cart reported success and the minicart still shows "${shown || 'nothing'}"`,
					)
				}
			})
		},
	},
]
