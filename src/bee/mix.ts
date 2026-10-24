/**
 * What share of a browser bee's shoppers only browse, add to the cart and
 * leave, or place an order. Each shopper draws one journey, so over a run the
 * mix shows up as the share of journeys of each kind.
 */
export type Journey = 'browse' | 'cart' | 'order'

export type Mix = Readonly<Record<Journey, number>>

export type MixName = 'browse' | 'normal-day' | 'checkout-stress'

/**
 * Visitor-to-order conversion: 1.62%, IRP Commerce, the UK Fashion Clothing &
 * Accessories market, September 2026, since the store sells clothing,
 * https://www.irpcommerce.com/en/gb/ecommercemarketdata.aspx?Market=3.
 */
export const NORMAL_DAY_ORDER = 0.0162

/**
 * Average cart abandonment: 70.22%, Baymard Institute,
 * https://baymard.com/lists/cart-abandonment-rate. Orders are the 29.78% of
 * carts that were not abandoned, so carts are orders / 0.2978 and the
 * abandoned ones are the rest.
 */
export const CART_ABANDONMENT = 0.7022

const normalDayCarts = NORMAL_DAY_ORDER / (1 - CART_ABANDONMENT)

export const MIXES: Readonly<Record<MixName, Mix>> = {
	browse: { browse: 1, cart: 0, order: 0 },
	'normal-day': {
		browse: 1 - normalDayCarts,
		cart: normalDayCarts - NORMAL_DAY_ORDER,
		order: NORMAL_DAY_ORDER,
	},
	// A chosen stress level, not a published figure: his 40% of shoppers completing the sale.
	'checkout-stress': { browse: 0.6, cart: 0, order: 0.4 },
}

export const isMixName = (name: string): name is MixName => Object.hasOwn(MIXES, name)

/** The journey a roll in [0, 1) lands on, so a test can choose the roll. */
export const journeyFor = (mix: Mix, roll: number): Journey => {
	if (roll < mix.order) return 'order'
	if (roll < mix.order + mix.cart) return 'cart'
	return 'browse'
}
