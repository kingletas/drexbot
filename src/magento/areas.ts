import type { Area } from '@harness/kernel'

/**
 * The storefront's sign-off sheet, declared separately from the checks so it
 * can report a gap, and every uncovered row carries a reason it prints.
 */
export const MAGENTO_AREAS: readonly Area[] = [
	{ id: 'home', title: 'The home page' },
	{ id: 'search', title: 'Catalogue search' },
	{ id: 'category', title: 'Category listing' },
	{ id: 'product', title: 'Product page' },
	{ id: 'cart', title: 'Cart and add-to-cart' },
	{ id: 'customer-account', title: 'Customer account' },
	{ id: 'admin', title: 'The admin, and who reaches it' },
	{ id: 'rest-api', title: 'The REST surface' },
	{ id: 'graphql', title: 'The GraphQL surface' },
	{ id: 'exposure', title: 'Files that must never be served' },
	{ id: 'compare', title: 'Product comparison' },
	{
		id: 'checkout',
		title: 'Checkout and payment',
		uncovered: {
			why: 'planned',
			note: 'the steps up to the payment method are covered; placing an order needs a sandbox gateway, and no payment method is configured',
		},
	},
	{
		id: 'wishlist',
		title: 'Wishlist',
		uncovered: {
			why: 'planned',
			note: 'needs a provisioned customer, which the adapter cannot create yet',
		},
	},
	{
		id: 'admin-workflows',
		title: 'Admin workflows — orders, catalogue, cache',
		uncovered: {
			why: 'planned',
			note: 'needs admin credentials the adapter is not given, so it can only prove the door is shut',
		},
	},
]
