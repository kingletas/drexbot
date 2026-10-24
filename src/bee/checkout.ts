import { randomBytes } from 'node:crypto'
import type { Page, Response } from 'playwright'
import type { Sample } from './lines.js'
import { measure } from './timing.js'

/**
 * A guest checkout on a Luma storefront, each step timed as a stage of its own.
 * The bee's image carries only this directory, so the selectors are copies of
 * entries in the Luma profile, and a unit test holds every copy to its original.
 */
export const BEE_SELECTORS = {
	sizeOption: '[data-attribute-code="size"] .swatch-option',
	colourOption: '[data-attribute-code="color"] .swatch-option',
	addToCart: 'button#product-addtocart-button',
	checkoutEmail: '#customer-email',
	firstName: 'input[name="firstname"]',
	lastName: 'input[name="lastname"]',
	streetLine: 'input[name="street[0]"]',
	city: 'input[name="city"]',
	postcode: 'input[name="postcode"]',
	telephone: 'input[name="telephone"]',
	region: 'select[name="region_id"]',
	shippingMethod: '.table-checkout-shipping-method input[type="radio"]',
	checkoutNext: 'button.continue',
	paymentStep: '#checkout-step-payment',
	placeOrder: '.payment-method._active button.action.primary.checkout',
	checkoutSuccess: '.checkout-success',
} as const

/** Check / Money order: the bee pays with nothing else, so no card number is ever typed. */
const CHECK_MONEY_ORDER = 'input#checkmo'

/** The block a configurable product's swatches are rendered into, present in the page before they are. */
const SWATCH_BLOCK = '.swatch-opt'

const STEP_TIMEOUT_MS = 60_000

/** Thrown when a step fails, after its failure has been recorded. */
export class StepFailed extends Error {}

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true })

/**
 * Times one step from its first action to the response it waited for, and
 * records it either way. A step that fails stops the journey there.
 */
const step = async (
	record: (sample: Sample) => void,
	stage: string,
	body: () => Promise<Response | null>,
): Promise<Response | null> => {
	const started = performance.now()
	try {
		const response = await body()
		const status = response?.status()
		record({ stage, status, totalMs: performance.now() - started })
		if (status !== undefined && status >= 400) throw new StepFailed(`${stage} answered ${status}`)
		return response
	} catch (cause) {
		if (cause instanceof StepFailed) throw cause
		record({ stage, status: undefined })
		throw new StepFailed(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`)
	}
}

const answered = (page: Page, path: string): Promise<Response> =>
	page.waitForResponse(
		response => response.url().includes(path) && response.request().method() === 'POST',
		{ timeout: STEP_TIMEOUT_MS },
	)

/**
 * Adds the product on the current page to the cart, choosing whatever options
 * it requires, and returns the status the store answered the add with.
 */
export const addToCart = async (
	page: Page,
	record: (sample: Sample) => void,
): Promise<number | undefined> => {
	const response = await step(record, 'cart', async () => {
		// Luma renders the swatches by script after the page loads, and an add
		// without them is refused in the browser and never reaches the store.
		if ((await page.locator(SWATCH_BLOCK).count()) > 0) {
			await visible(page, `${SWATCH_BLOCK} .swatch-option`)
				.first()
				.waitFor({ timeout: STEP_TIMEOUT_MS })
		}
		for (const option of [BEE_SELECTORS.sizeOption, BEE_SELECTORS.colourOption]) {
			const swatch = visible(page, option).first()
			if ((await swatch.count()) > 0) await swatch.click()
		}
		const added = answered(page, '/checkout/cart/add')
		await visible(page, BEE_SELECTORS.addToCart).first().click()
		return added
	})
	return response?.status()
}

/**
 * From a cart holding a row to the confirmation page, as a guest paying by
 * Check / Money order. Choosing the method sends nothing to the store, so it is
 * timed with placing the order rather than as a step of its own. Returns the
 * confirmation page's status.
 */
export const placeOrder = async (
	page: Page,
	baseUrl: string,
	record: (sample: Sample) => void,
): Promise<number> => {
	await step(record, 'checkout', async () => {
		const opened = await page.goto(new URL('/checkout/', baseUrl).href, {
			waitUntil: 'domcontentloaded',
			timeout: STEP_TIMEOUT_MS,
		})
		await visible(page, BEE_SELECTORS.checkoutEmail).first().waitFor({ timeout: STEP_TIMEOUT_MS })
		return opened
	})

	await step(record, 'shipping', async () => {
		const nonce = randomBytes(4).toString('hex')
		for (const [selector, value] of [
			[BEE_SELECTORS.checkoutEmail, `drexbot-bee-${nonce}@drexbot.test`],
			[BEE_SELECTORS.firstName, 'Drex'],
			[BEE_SELECTORS.lastName, 'Bot'],
			[BEE_SELECTORS.streetLine, '123 Test Street'],
			[BEE_SELECTORS.city, 'Austin'],
			[BEE_SELECTORS.postcode, '78701'],
			[BEE_SELECTORS.telephone, '5125550100'],
		] as const) {
			await visible(page, selector).first().fill(value, { timeout: STEP_TIMEOUT_MS })
		}
		const region = visible(page, BEE_SELECTORS.region).first()
		if ((await region.count()) > 0) await region.selectOption({ index: 1 })
		await page.locator(BEE_SELECTORS.shippingMethod).first().check({ timeout: STEP_TIMEOUT_MS })
		const saved = answered(page, '/shipping-information')
		await visible(page, BEE_SELECTORS.checkoutNext).first().click()
		const response = await saved
		await visible(page, BEE_SELECTORS.paymentStep).first().waitFor({ timeout: STEP_TIMEOUT_MS })
		return response
	})

	// Luma sends the shopper to the success page as soon as the order is placed,
	// so the navigation is listened for before the click that causes it.
	const confirmed = page.waitForResponse(
		response =>
			response.url().includes('/checkout/onepage/success') &&
			response.request().isNavigationRequest(),
		{ timeout: STEP_TIMEOUT_MS * 2 },
	)
	confirmed.catch(() => undefined)

	await step(record, 'place-order', async () => {
		// With one method on offer Luma selects it and hides its radio, so the
		// method is only checked when the shopper could see it to choose.
		const method = page.locator(CHECK_MONEY_ORDER)
		await method.waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS })
		if (await method.isVisible()) await method.check()
		const placed = answered(page, '/payment-information')
		await visible(page, BEE_SELECTORS.placeOrder).first().click({ timeout: STEP_TIMEOUT_MS })
		return placed
	})

	// The confirmation is a page load, so it carries the page's own timing as well as the step's.
	const started = performance.now()
	try {
		const response = await confirmed
		await visible(page, BEE_SELECTORS.checkoutSuccess).first().waitFor({ timeout: STEP_TIMEOUT_MS })
		const timing = await measure(page)
		record({
			stage: 'confirmation',
			status: response.status(),
			totalMs: performance.now() - started,
			...(timing.ttfb !== undefined ? { ttfbMs: timing.ttfb } : {}),
			...(timing.lcp !== undefined ? { lcpMs: timing.lcp } : {}),
		})
		return response.status()
	} catch (cause) {
		record({ stage: 'confirmation', status: undefined })
		throw new StepFailed(`confirmation: ${cause instanceof Error ? cause.message : String(cause)}`)
	}
}
