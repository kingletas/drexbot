import type { CheckDefinition } from 'harness-kernel'
import { AssertionFailure, PreconditionFailure } from 'harness-kernel'
import type { BrowserSurface, PageSession } from '../surfaces/browser.js'
import { NO_BASELINE, type StoreBaseline } from './baseline.js'
import { answerShippingStep, fillCart, openProduct, registerCustomer } from './shopper.js'

/**
 * The vanilla ground a release is signed off on beyond the first click: sorting,
 * paging and filtering a listing, emptying a cart, registering, and reaching the
 * payment step. Every check asserts a change, as the rest of the suite does.
 */
export const depthChecks = (
	browser: () => Promise<BrowserSurface>,
	store: StoreBaseline,
): readonly CheckDefinition[] => {
	const needs = ['browser'] as const

	const guard = (): void => {
		if (!store.captured) throw new PreconditionFailure(NO_BASELINE)
	}

	/** The names on the listing, in the order the page put them. */
	const listing = async ({ find }: PageSession): Promise<string[]> =>
		(await (await find('productLink')).allInnerTexts()).map(name => name.trim())

	return [
		{
			id: 'magento.depth.sorting-reorders-the-listing',
			title: 'Sorting a category listing changes the order it is in',
			suite: 'depth',
			area: 'category',
			needs: [...needs],
			async body({ record, artefactDir, attach }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						const before = await listing(session)
						await (await session.find('sortSelect', { unique: true })).selectOption('price')
						await session.page.waitForLoadState('domcontentloaded')
						const after = await listing(session)

						record('first product', `${before[0] ?? 'none'} then ${after[0] ?? 'none'}`)

						if (before.length === 0 || after.length === 0) {
							throw new AssertionFailure('the listing rendered no products to sort')
						}
						if (before.join('|') === after.join('|')) {
							throw new AssertionFailure(
								`sorting by price left all ${after.length} products in the same order`,
							)
						}
					},
					{ dir: artefactDir, attach },
				)
			},
		},
		{
			id: 'magento.depth.pagination-shows-another-page',
			title: 'The next page of a listing holds different products',
			suite: 'depth',
			area: 'category',
			needs: [...needs],
			async body({ record, artefactDir, attach }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						const first = await listing(session)
						if (!(await session.present('paginationNext'))) {
							throw new PreconditionFailure(
								`${store.categoryPath} fits on one page, so there is no second one to compare`,
							)
						}

						await (await session.find('paginationNext')).first().click()
						await session.page.waitForLoadState('domcontentloaded')
						const second = await listing(session)

						record('page 1', `${first.length} products`)
						record('page 2', `${second.length} products`)

						const shared = second.filter(name => first.includes(name))
						if (second.length === 0 || shared.length === second.length) {
							throw new AssertionFailure('the second page repeated the first')
						}
					},
					{ dir: artefactDir, attach },
				)
			},
		},
		{
			id: 'magento.depth.a-filter-narrows-the-listing',
			title: 'Applying a layered filter narrows the listing and says it is applied',
			suite: 'depth',
			area: 'category',
			needs: [...needs],
			async body({ record, artefactDir, attach }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						/** How many products the toolbar says match, rather than how many fit on the page. */
						const total = async (): Promise<number> => {
							const shown = await (await session.find('toolbarAmount')).first().innerText()
							const numbers = shown.match(/\d+/g) ?? []
							return Number(numbers.at(-1) ?? '0')
						}

						const before = await listing(session)
						const beforeTotal = await total()
						if (!(await session.present('filterOption'))) {
							throw new PreconditionFailure(
								`${store.categoryPath} offers no layered navigation to filter by`,
							)
						}

						// Every group is a `data-role="collapsible"`, so its options are in the
						// DOM and hidden until the title is clicked. Opening one is part of
						// filtering, not setup.
						const options = (await session.find('filterOption')).filter({ visible: true })
						if ((await options.count()) === 0) {
							await (await session.find('filterTitle')).first().click()
						}
						await options.first().click()
						await session.page.waitForLoadState('domcontentloaded')
						const after = await listing(session)

						record('matching', `${beforeTotal} then ${await total()}`)
						record('on the page', `${before.length} then ${after.length}`)

						if (after.length === 0) {
							throw new AssertionFailure('filtering left a listing with nothing in it')
						}
						// The toolbar's total, not the page's rows: a page shows at most its
						// page size, so a filter that halved a 50-product category would
						// leave both pages looking identical.
						if ((await total()) >= beforeTotal) {
							throw new AssertionFailure(
								`filtering did not narrow anything: ${beforeTotal} matching before, ${await total()} after`,
							)
						}
						if (!(await session.present('filterActive'))) {
							throw new AssertionFailure(
								'the listing narrowed and nothing on the page says a filter is applied',
							)
						}
					},
					{ dir: artefactDir, attach },
				)
			},
		},
		{
			id: 'magento.depth.removing-the-line-empties-the-cart',
			title: 'Removing the only line leaves the cart empty and says so',
			suite: 'depth',
			area: 'cart',
			needs: [...needs],
			async body({ record, artefactDir, attach }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						await fillCart(session, store)
						const before = await (await session.find('cartRow')).count()
						if (before === 0) throw new AssertionFailure('nothing reached the cart to remove')

						await (await session.find('cartRemove')).first().click()
						await session.page.waitForLoadState('domcontentloaded')

						// Asked with `present`, because an emptied cart has no rows and `find`
						// throws when nothing resolves — which is the state being asserted.
						const stillThere = await session.present('cartRow', { timeoutMs: 3_000 })
						record('cart rows', `${before} then ${stillThere ? 'still there' : 'none'}`)

						if (stillThere) {
							throw new AssertionFailure('removing the line left the row in the cart')
						}
						if (!(await session.present('cartEmpty'))) {
							throw new AssertionFailure('the cart lost its row and never said it was empty')
						}
					},
					{ dir: artefactDir, attach },
				)
			},
		},
		{
			id: 'magento.depth.registering-signs-you-in',
			title: 'Registering an account leaves the shopper signed in',
			suite: 'depth',
			area: 'customer-account',
			// It writes a customer this harness cannot delete afterwards, so it may
			// only run somewhere that declares itself disposable.
			needs: [...needs, 'isDisposable'],
			async body({ rng, record, artefactDir, attach }) {
				const surface = await browser()
				const nonce = Math.floor(rng() * 0xffffffff).toString(16)

				await surface.visit(
					'/customer/account/create/',
					async session => {
						const email = await registerCustomer(session, store, nonce)
						record('registered as', email)
						record('landed on', new URL(session.page.url()).pathname)

						// This address, not any dashboard — and waited for, because Luma fills
						// the contact block from a request that lands after the page has.

						await session.page
							.getByText(email, { exact: false })
							.first()
							.waitFor({ timeout: 30_000 })
							.catch(() => {
								throw new AssertionFailure(
									`registering did not leave ${email} signed in — the account page never named the address`,
								)
							})
					},
					{ dir: artefactDir, attach },
				)
			},
		},
		{
			id: 'magento.depth.guest-checkout-reaches-payment',
			title: 'A guest cart moves from the shipping step to the payment step',
			suite: 'depth',
			area: 'checkout',
			needs: [...needs],
			async body({ record, artefactDir, attach }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						const { find, page, present } = session
						await fillCart(session, store)
						await (await find('proceedToCheckout', { unique: true })).click()

						// Checkout is one page that swaps steps, so what is asserted is that
						// the step changed. Reading payment before shipping is answered would
						// make reaching it prove nothing.
						const early = await present('paymentStep', { timeoutMs: 5_000 })
						record('payment before shipping', String(early))
						if (early) {
							throw new AssertionFailure(
								'the payment step was showing before shipping was answered',
							)
						}

						await answerShippingStep(session, {
							email: 'drexbot-guest@drexbot.test',
							firstName: 'Drex',
							lastName: 'Bot',
						})
						record('reached', `the payment step at ${new URL(page.url()).hash || '/checkout/'}`)
					},
					{ dir: artefactDir, attach },
				)
			},
		},
		{
			id: 'magento.depth.wishlist-holds-what-was-added',
			title: 'A signed-in shopper can put a product on an empty wish list',
			suite: 'depth',
			area: 'wishlist',
			// It registers a customer this harness cannot delete afterwards, so it
			// may only run somewhere that declares itself disposable. The capability
			// for provisioning promises removal too, and a storefront cannot.
			needs: [...needs, 'isDisposable'],
			async body({ rng, record, artefactDir, attach }) {
				guard()
				const surface = await browser()
				const nonce = Math.floor(rng() * 0xffffffff).toString(16)

				await surface.visit(
					store.categoryPath,
					async session => {
						const { find, page, present } = session
						await registerCustomer(session, store, nonce)

						// A fresh account's list is empty, which is what makes the assertion
						// a change rather than a count that happened to be above zero.
						await page.goto(`${store.baseUrl}/wishlist/`, { waitUntil: 'domcontentloaded' })
						const before = await present('wishlistItem', { timeoutMs: 3_000 })
						record('wish list before', before ? 'already holds something' : 'empty')
						if (before) {
							throw new AssertionFailure('a newly registered account already has a wish list')
						}

						await page.goto(`${store.baseUrl}${store.categoryPath}`, {
							waitUntil: 'domcontentloaded',
						})
						await openProduct(session)
						const wanted = (await (await find('pageTitle')).first().innerText()).trim()

						await (await find('wishlistAdd', { unique: true })).click()
						await page.waitForURL(url => url.pathname.includes('/wishlist'), {
							timeout: 60_000,
							waitUntil: 'domcontentloaded',
						})

						const held = (await (await find('wishlistItem')).allInnerTexts()).map(name =>
							name.trim(),
						)
						record('wish list after', held.join(', ') || 'still empty')

						// The product, not a product: a list that renders one row proves
						// nothing about what was added to it.
						if (!held.some(name => name === wanted)) {
							throw new AssertionFailure(
								`the wish list does not hold "${wanted}" — it holds ${held.join(', ') || 'nothing'}`,
							)
						}
					},
					{ dir: artefactDir, attach },
				)
			},
		},
	]
}
