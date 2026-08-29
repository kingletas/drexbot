import type { CheckDefinition } from '@harness/kernel'
import { AssertionFailure, PreconditionFailure } from '@harness/kernel'
import type { BrowserSurface, PageSession } from '../surfaces/browser.js'
import { NO_BASELINE, type StoreBaseline } from './baseline.js'

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

	const openProduct = async ({ page, find }: PageSession): Promise<void> => {
		await (await find('productLink')).first().click()
		await page.waitForLoadState('domcontentloaded')
	}

	const chooseOptions = async ({ find, present }: PageSession): Promise<void> => {
		for (const option of ['sizeOption', 'colourOption'] as const) {
			if (await present(option)) await (await find(option)).first().click()
		}
	}

	/** Adds the category's first product and lands on the cart page. */
	const fillCart = async (session: PageSession): Promise<void> => {
		await openProduct(session)
		await chooseOptions(session)
		await (await session.find('addToCart', { unique: true })).click()
		await (await session.find('successMessage', { timeoutMs: 20_000 })).first().waitFor()
		await session.page.goto(`${new URL(session.page.url()).origin}/checkout/cart/`, {
			waitUntil: 'domcontentloaded',
		})
	}

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
						await fillCart(session)
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
				const email = `drexbot-${nonce}@drexbot.test`

				await surface.visit(
					'/customer/account/create/',
					async session => {
						const { find, page } = session
						await (await find('firstName', { unique: true })).fill('Drex')
						await (await find('lastName', { unique: true })).fill('Bot')
						await (await find('emailField', { unique: true })).fill(email)
						await (await find('passwordField', { unique: true })).fill(`Dx-${nonce}-9!`)
						await (await find('passwordConfirm', { unique: true })).fill(`Dx-${nonce}-9!`)
						record('registered as', email)

						// waitForLoadState settles on the page that is already there, so a form
						// submission is waited for by the URL it leaves rather than by a load
						// that has not started.
						await (await find('registerSubmit', { unique: true })).click()
						await page.waitForURL(url => !url.pathname.includes('/create'), {
							timeout: 60_000,
							waitUntil: 'domcontentloaded',
						})

						// The address is the assertion: a dashboard that renders for anybody
						// proves nothing, and the account has to be *this* one.
						const shown = await page.locator('body').innerText()
						record('landed on', new URL(page.url()).pathname)

						if (!shown.includes(email)) {
							throw new AssertionFailure(
								`registering did not leave ${email} signed in — the page never names the address`,
							)
						}
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
						await fillCart(session)
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

						// The form is Knockout-rendered after the cart is fetched, so the
						// first field is waited for rather than assumed.
						await (await find('checkoutEmail', { timeoutMs: 90_000 })).first().waitFor()
						for (const [entry, value] of [
							['checkoutEmail', 'drexbot-guest@drexbot.test'],
							['firstName', 'Drex'],
							['lastName', 'Bot'],
							['streetLine', '123 Test Street'],
							['city', 'Austin'],
							['postcode', '78701'],
							['telephone', '5125550100'],
						] as const) {
							await (await find(entry, { unique: true, timeoutMs: 30_000 })).fill(value)
						}
						if (await present('region', { timeoutMs: 5_000 })) {
							await (await find('region', { unique: true })).selectOption({ index: 1 })
						}

						// A rate only appears once the address is complete enough to price.
						await (await find('shippingMethod', { timeoutMs: 90_000 })).first().check()
						await (await find('checkoutNext', { unique: true })).click()

						await (await find('paymentStep', { timeoutMs: 90_000 })).first().waitFor()
						record('reached', `the payment step at ${new URL(page.url()).hash || '/checkout/'}`)
					},
					{ dir: artefactDir, attach },
				)
			},
		},
	]
}
