import type { CheckDefinition } from 'harness-kernel'
import { AssertionFailure, PreconditionFailure } from 'harness-kernel'
import type { BrowserSurface } from '../surfaces/browser.js'
import { NO_BASELINE, type StoreBaseline } from './baseline.js'
import { chooseOptions, openProduct } from './shopper.js'

/**
 * What a shopper does after the first click, every check asserting a *change*
 * because a presence check passes against a page where nothing works.
 */
export const regressionChecks = (
	browser: () => Promise<BrowserSurface>,
	store: StoreBaseline,
): readonly CheckDefinition[] => {
	const needs = ['browser'] as const

	const guard = (): void => {
		if (!store.captured) throw new PreconditionFailure(NO_BASELINE)
	}

	return [
		{
			id: 'magento.regression.product-tabs-switch',
			title: 'A product page has information tabs and switching one changes the panel',
			suite: 'regression',
			area: 'product',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						await openProduct(session)

						const tabs = await session.find('productTab')
						const count = await tabs.count()
						record('tabs', String(count))
						if (count < 2) {
							throw new AssertionFailure(`the product page shows ${count} information tab(s)`)
						}

						const panels = await session.find('productTabPanel')
						const before = await panels.first().isVisible()
						await tabs.nth(1).click()
						await session.page.waitForTimeout(500)
						const after = await panels.first().isVisible()

						// The panel that was showing must stop showing. A tab that renders
						// and changes nothing is the defect this is aimed at.
						record(
							'first panel',
							`${before ? 'shown' : 'hidden'} then ${after ? 'shown' : 'hidden'}`,
						)
						if (before === after) {
							throw new AssertionFailure(
								'clicking the second tab did not change which panel is shown',
							)
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
		{
			id: 'magento.regression.swatch-changes-the-selection',
			title: 'Choosing a swatch marks it selected',
			suite: 'regression',
			area: 'product',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						await openProduct(session)

						if (!(await session.present('colourOption'))) {
							// A store whose catalogue has no configurable product cannot be
							// asked this, and that is a fact about the catalogue.
							throw new PreconditionFailure('this product has no colour swatches to choose')
						}

						const swatches = await session.find('colourOption')
						const before = (await swatches.first().getAttribute('class')) ?? ''
						await swatches.first().click()
						await session.page.waitForTimeout(400)
						const after = (await swatches.first().getAttribute('class')) ?? ''

						record(
							'swatch class',
							`${before.includes('selected') ? 'selected' : 'plain'} then ${after.includes('selected') ? 'selected' : 'plain'}`,
						)
						if (before === after) {
							throw new AssertionFailure('clicking a swatch left it looking exactly as it did')
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
		{
			id: 'magento.regression.minicart-lists-what-was-added',
			title: 'The mini cart lists the product that was added, with a subtotal',
			suite: 'regression',
			area: 'cart',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						await openProduct(session)
						const name = (await (await session.find('pageTitle')).first().innerText()).trim()

						await chooseOptions(session)
						await (await session.find('addToCart', { unique: true })).click()
						await (await session.find('successMessage', { timeoutMs: 20_000 })).first().waitFor()

						await (await session.find('minicartToggle', { unique: true })).click()
						const items = await session.find('minicartItem', { timeoutMs: 15_000 })
						const listed = await items.first().innerText()
						record('mini cart', listed.replace(/\s+/g, ' ').slice(0, 60))

						// The drawer showing *a* row is not the check; it showing the row
						// for the product just added is.
						if (!listed.toLowerCase().includes(name.toLowerCase().split(' ')[0] ?? name)) {
							throw new AssertionFailure(
								`the mini cart lists "${listed.trim()}" after adding "${name}"`,
							)
						}

						const subtotal = (
							await (await session.find('minicartSubtotal')).first().innerText()
						).trim()
						record('subtotal', subtotal)
						if (!/\d/.test(subtotal)) {
							throw new AssertionFailure(`the mini cart subtotal reads "${subtotal}"`)
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
		{
			id: 'magento.regression.quantity-moves-the-subtotal',
			title: 'Changing the quantity in the cart changes the subtotal',
			suite: 'regression',
			area: 'cart',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						await openProduct(session)
						await chooseOptions(session)
						await (await session.find('addToCart', { unique: true })).click()
						await (await session.find('successMessage', { timeoutMs: 20_000 })).first().waitFor()

						await session.page.goto(`${store.baseUrl}/checkout/cart/`, {
							waitUntil: 'domcontentloaded',
						})

						const subtotalOf = async (): Promise<string> =>
							(await (await session.find('cartSubtotal')).first().innerText()).trim()

						const before = await subtotalOf()
						const quantity = await session.find('cartQuantity', { unique: true })
						await quantity.fill('3')
						await (await session.find('cartUpdate', { unique: true })).click()
						await session.page.waitForLoadState('domcontentloaded')
						await session.page.waitForTimeout(1_500)
						const after = await subtotalOf()

						record('subtotal', `${before} then ${after}`)
						if (before === after) {
							throw new AssertionFailure(
								`the subtotal stayed at ${before} after the quantity went from 1 to 3`,
							)
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
		{
			id: 'magento.regression.compare-holds-two-products',
			title: 'Two products can be compared side by side',
			suite: 'regression',
			area: 'compare',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						const tiles = await session.find('productTile')
						if ((await tiles.count()) < 2) {
							throw new PreconditionFailure('this category has fewer than two products to compare')
						}

						// The compare link only appears on hover in Luma, so each tile is
						// hovered before its link is clicked.
						for (const index of [0, 1]) {
							await tiles.nth(index).hover()
							await (await session.find('compareButton')).nth(index).click()
							await session.page.waitForTimeout(1_500)
						}

						await session.page.goto(`${store.baseUrl}/catalog/product_compare/index/`, {
							waitUntil: 'domcontentloaded',
						})

						const named = await session.find('compareCell', { timeoutMs: 15_000 })
						const count = await named.count()
						record('products compared', String(count))

						if (count < 2) {
							throw new AssertionFailure(
								`the comparison holds ${count} product(s) after adding two`,
							)
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
		{
			id: 'magento.regression.no-results-says-so',
			title: 'A search with no matches says so rather than erroring',
			suite: 'regression',
			area: 'search',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()
				const nonsense = 'zzqqxxnothinghere'

				await surface.visit(
					`/catalogsearch/result/?q=${nonsense}`,
					async session => {
						const tiles = await session.present('productTile', { timeoutMs: 3_000 })
						record('products shown', tiles ? 'some' : 'none')

						const message = await session.find('noResults', { timeoutMs: 10_000 })
						const text = (await message.first().innerText()).trim()
						record('message', text.replace(/\s+/g, ' ').slice(0, 80))

						// An empty page with no message is the defect: the shopper cannot
						// tell a store with nothing matching from a store that is broken.
						if (text.length === 0) {
							throw new AssertionFailure('a search with no matches rendered no message at all')
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
	]
}
