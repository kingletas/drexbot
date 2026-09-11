import type { CheckDefinition } from 'harness-kernel'
import { AssertionFailure, NO_RETRY, PreconditionFailure } from 'harness-kernel'
import type { BrowserSurface, PageSession } from '../surfaces/browser.js'
import { NO_BASELINE, type StoreBaseline } from './baseline.js'
import { answerShippingStep, fillCart, type Shopper } from './shopper.js'

/** Magento writes an increment id of digits, and the success page prints it. */
const ORDER_NUMBER = /\b(\d{6,})\b/

/**
 * The end of the journey a storefront exists for: what a shopper may pay with,
 * and whether an order they place is one the store afterwards has.
 */
export const checkoutChecks = (
	browser: () => Promise<BrowserSurface>,
	store: StoreBaseline,
): readonly CheckDefinition[] => {
	const needs = ['browser'] as const

	const guard = (): void => {
		if (!store.captured) throw new PreconditionFailure(NO_BASELINE)
	}

	/**
	 * How many methods the step says are unavailable, counted by visibility. The
	 * "No Payment method available." block is in the DOM of every checkout and
	 * hidden, so asking whether it is *present* answers yes on a healthy store.
	 */
	const saysNoneAvailable = async ({ find, present }: PageSession): Promise<number> =>
		(await present('paymentUnavailable', { timeoutMs: 3_000 }))
			? await (await find('paymentUnavailable')).filter({ visible: true }).count()
			: 0

	/** The titles of the methods on offer, as a shopper reads them, or none. */
	const methodsOffered = async (session: PageSession): Promise<string[]> => {
		// Asked rather than found, because a step offering nothing is a verdict
		// this suite states in its own words rather than a selector to report.
		if (!(await session.present('paymentMethodTitle', { timeoutMs: 30_000 }))) return []

		const titles = await session.find('paymentMethodTitle')
		const shown = await titles.filter({ visible: true }).allInnerTexts()
		return shown.map(title => title.trim().replace(/\s+/g, ' ')).filter(title => title !== '')
	}

	return [
		{
			id: 'magento.checkout.payment-step-offers-a-method',
			title: 'The payment step offers a method a shopper can pay with',
			suite: 'checkout',
			area: 'checkout',
			needs: [...needs],
			async body({ record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()

				await surface.visit(
					store.categoryPath,
					async session => {
						await fillCart(session, store)
						await session.page.goto(`${store.baseUrl}/checkout/`, {
							waitUntil: 'domcontentloaded',
						})
						await answerShippingStep(session, {
							email: 'drexbot-guest@drexbot.test',
							firstName: 'Drex',
							lastName: 'Bot',
						})

						const offered = await methodsOffered(session)
						const unavailable = await saysNoneAvailable(session)
						record('methods offered', offered.join(', ') || 'none')
						record('says none available', unavailable === 0 ? 'no' : 'yes')

						if (offered.length === 0) {
							throw new AssertionFailure(
								'the payment step named no method a shopper could pay with',
							)
						}
						if (unavailable > 0) {
							throw new AssertionFailure(
								`the payment step offers ${offered.join(', ')} and also tells the shopper no method is available`,
							)
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
		{
			id: 'magento.checkout.an-order-is-placed-and-can-be-found-again',
			title: 'An order placed at the storefront is one the store afterwards has',
			suite: 'checkout',
			area: 'checkout',
			// It writes an order this harness cannot remove, so it may only run
			// somewhere that declares itself disposable.
			needs: [...needs, 'isDisposable'],
			// A timeout anywhere after the order is placed would otherwise be
			// retried, and the second attempt would place a second order.
			retry: NO_RETRY,
			async body({ rng, record, artefactDir, attach, signal }) {
				guard()
				const surface = await browser()
				const nonce = Math.floor(rng() * 0xffffffff).toString(16)
				const shopper: Shopper = {
					email: `drexbot-${nonce}@drexbot.test`,
					firstName: 'Drex',
					lastName: 'Bot',
				}

				await surface.visit(
					store.categoryPath,
					async session => {
						const { find, page, present } = session
						await fillCart(session, store)
						await page.goto(`${store.baseUrl}/checkout/`, { waitUntil: 'domcontentloaded' })
						await answerShippingStep(session, shopper)

						// With one method on offer Magento selects it, so choosing is only
						// done when a radio is actually there to choose.
						if (await present('paymentMethod', { timeoutMs: 5_000 })) {
							const radio = (await find('paymentMethod')).first()
							await radio.check().catch(() => undefined)
						}
						const paying = await methodsOffered(session)
						record('paying with', paying.join(', ') || 'none')
						if (paying.length === 0) {
							throw new AssertionFailure(
								'the payment step named no method, so there was nothing to place an order with',
							)
						}

						await (await find('placeOrder', { unique: true, timeoutMs: 30_000 })).click()
						await page
							.waitForURL(url => url.pathname.includes('/checkout/onepage/success'), {
								timeout: 120_000,
								waitUntil: 'domcontentloaded',
							})
							.catch(() => undefined)

						const acknowledgement = (
							await (await find('checkoutSuccess', { timeoutMs: 30_000 })).first().innerText()
						)
							.replace(/\s+/g, ' ')
							.trim()
						const number = ORDER_NUMBER.exec(acknowledgement)?.[1]
						record('acknowledged', acknowledgement.slice(0, 120))
						if (number === undefined) {
							throw new AssertionFailure(
								`the checkout finished and named no order number: "${acknowledgement.slice(0, 160)}"`,
							)
						}
						record('order', number)

						// Placing empties the quote, so a cart that still has a row means
						// the acknowledgement described something that did not happen.
						await page.goto(`${store.baseUrl}/checkout/cart/`, {
							waitUntil: 'domcontentloaded',
						})
						if (await present('cartRow', { timeoutMs: 3_000 })) {
							throw new AssertionFailure(
								`order ${number} was acknowledged and the cart still holds a row`,
							)
						}

						// A success page is a page: what makes the order real is the store
						// finding it again, asked as a shopper would through Orders and Returns.

						// The form is a private block Magento re-renders for a visitor that
						// already has a session, so filling before that lands puts the values
						// into markup that is then replaced.
						const rendered = page
							.waitForResponse(
								response =>
									response.url().includes('page_cache/block/render') &&
									decodeURIComponent(response.url()).includes('guest.form'),
								{ timeout: 30_000 },
							)
							.catch(() => undefined)
						await page.goto(`${store.baseUrl}/sales/guest/form/`, {
							waitUntil: 'domcontentloaded',
						})
						await rendered
						await (await find('orderLookupId', { unique: true })).fill(number)
						await (await find('orderLookupLastName', { unique: true })).fill(shopper.lastName)
						await (await find('orderLookupEmail', { unique: true })).fill(shopper.email)
						// The submission is waited for rather than a load state, which
						// settles on the page that is already there and lets the check read
						// the form it just submitted.
						const looked = page.waitForResponse(
							response =>
								response.url().includes('/sales/guest/') && response.request().method() === 'POST',
							{ timeout: 60_000 },
						)
						await (await find('orderLookupSubmit', { unique: true })).click()
						await looked
						await page.waitForLoadState('domcontentloaded')

						const found = (await (await find('pageTitle')).first().innerText())
							.replace(/\s+/g, ' ')
							.trim()
						record('looked up', found)

						if (!found.includes(number)) {
							throw new AssertionFailure(
								`the store cannot find order ${number} it just acknowledged — the lookup landed on "${found}"`,
							)
						}
					},
					{ dir: artefactDir, attach, signal },
				)
			},
		},
	]
}
