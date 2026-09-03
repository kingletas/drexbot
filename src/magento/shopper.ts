import { AssertionFailure } from 'harness-kernel'
import type { PageSession } from '../surfaces/browser.js'
import type { StoreBaseline } from './baseline.js'

/** Opens the first product of whichever listing the session is on. */
export const openProduct = async ({ page, find }: PageSession): Promise<void> => {
	await (await find('productLink')).first().click()
	await page.waitForLoadState('domcontentloaded')
}

/**
 * Chooses every option a configurable product requires. A simple product has
 * none, and skipping them is correct.
 */
export const chooseOptions = async ({ find, present }: PageSession): Promise<void> => {
	for (const option of ['sizeOption', 'colourOption'] as const) {
		if (await present(option)) await (await find(option)).first().click()
	}
}

/** Adds the listing's first product and lands on the cart page holding a row. */
export const fillCart = async (session: PageSession, store: StoreBaseline): Promise<void> => {
	await openProduct(session)
	await chooseOptions(session)
	// Adding is an AJAX post, and navigating away before it answers cancels it.
	// The request is waited for rather than the banner, which belongs to the
	// checks that are about the banner.
	const added = session.page.waitForResponse(
		response => response.url().includes('/checkout/cart/add') && response.status() < 400,
		{ timeout: 60_000 },
	)
	await (await session.find('addToCart', { unique: true })).click()
	const answered = (await added).status()

	await session.page.goto(`${store.baseUrl}/checkout/cart/`, { waitUntil: 'domcontentloaded' })
	// Asked rather than found: this store accepts an add and then serves a cart
	// without it, and reporting that as a selector nobody can find is the
	// store-is-broken reading rather than what happened.
	if (!(await session.present('cartRow', { timeoutMs: 30_000 }))) {
		throw new AssertionFailure(
			`the store answered the add with ${answered} and the cart it then served holds no row`,
		)
	}
}

/** What a checkout needs to know about whoever is buying. */
export interface Shopper {
	readonly email: string
	readonly firstName: string
	readonly lastName: string
}

/**
 * Registers a customer through the storefront's own form and leaves the session
 * signed in as them. The address is returned so a check can assert against the
 * account it actually made.
 */
export const registerCustomer = async (
	session: PageSession,
	store: StoreBaseline,
	nonce: string,
): Promise<string> => {
	const { find, page } = session
	const email = `drexbot-${nonce}@drexbot.test`

	await page.goto(`${store.baseUrl}/customer/account/create/`, { waitUntil: 'domcontentloaded' })
	await (await find('firstName', { unique: true })).fill('Drex')
	await (await find('lastName', { unique: true })).fill('Bot')
	await (await find('emailField', { unique: true })).fill(email)
	await (await find('passwordField', { unique: true })).fill(`Dx-${nonce}-9!`)
	await (await find('passwordConfirm', { unique: true })).fill(`Dx-${nonce}-9!`)

	// waitForLoadState settles on the page that is already there, so a form
	// submission is waited for by the URL it leaves rather than by a load that
	// has not started.
	await (await find('registerSubmit', { unique: true })).click()
	await page.waitForURL(url => !url.pathname.includes('/create'), {
		timeout: 60_000,
		waitUntil: 'domcontentloaded',
	})

	return email
}

/**
 * Answers the shipping step for a guest and leaves the checkout showing the
 * payment step. Checkout is one page that swaps steps, so what is waited for is
 * the step arriving rather than a navigation.
 */
export const answerShippingStep = async (session: PageSession, shopper: Shopper): Promise<void> => {
	const { find, present } = session

	// The form is Knockout-rendered after the cart is fetched, and the ceiling is
	// minutes because a store serving static content on demand materialises
	// hundreds of files the first time anything opens the checkout.
	await (await find('checkoutEmail', { timeoutMs: 180_000 })).first().waitFor({
		timeout: 180_000,
	})
	for (const [entry, value] of [
		['checkoutEmail', shopper.email],
		['firstName', shopper.firstName],
		['lastName', shopper.lastName],
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
	await (await find('shippingMethod', { timeoutMs: 120_000 })).first().check()
	await (await find('checkoutNext', { unique: true })).click()
	await (await find('paymentStep', { timeoutMs: 120_000 })).first().waitFor()
}
