/**
 * Storefront paths the smoke suite walks, and the files that must never be
 * served whatever else is true.
 */
export interface StorefrontPage {
	readonly id: string
	readonly path: string
	readonly title: string
	/** The sign-off sheet row this page reports into. */
	readonly area: string
	/** Whether this path is a fact about the catalogue, and so needs a baseline first. */
	readonly needsCatalogue?: boolean
	/** A string the rendered page must contain, proving it is the page and not an error. */
	readonly mustContain: string
}

import type { StoreBaseline } from './baseline.js'

/**
 * The pages a shopper cannot do without, for *this* store — built from the
 * baseline, because a constant here would pin the harness to one catalogue.
 */
export const storefrontPages = (store: StoreBaseline): readonly StorefrontPage[] => [
	{
		area: 'home',
		id: 'home',
		path: '/',
		title: 'The home page renders',
		mustContain: 'cms-index-index',
	},
	{
		area: 'category',
		needsCatalogue: true,
		id: 'category',
		path: store.categoryPath,
		title: 'A category listing renders',
		mustContain: 'catalog-category-view',
	},
	{
		area: 'search',
		needsCatalogue: true,
		id: 'search',
		path: `/catalogsearch/result/?q=${encodeURIComponent(store.searchTerm)}`,
		title: 'Search returns a results page',
		mustContain: 'catalogsearch-result-index',
	},
	{
		area: 'cart',
		id: 'cart',
		path: '/checkout/cart/',
		title: 'The cart page renders',
		mustContain: 'checkout-cart-index',
	},
	{
		area: 'customer-account',
		id: 'login',
		path: '/customer/account/login/',
		title: 'The customer login page renders',
		mustContain: 'customer-account-login',
	},
]

/** Files that must not be served in any mode on any host, each leaking something specific. */
export interface ForbiddenFile {
	readonly path: string
	readonly why: string
}

export const MUST_NOT_SERVE: readonly ForbiddenFile[] = [
	{ path: '/app/etc/env.php', why: 'the database password and the crypt key' },
	{ path: '/app/etc/config.php', why: 'the enabled module list' },
	{ path: '/.git/config', why: 'the git remote, and that a working tree is deployed' },
	{ path: '/.env', why: 'whatever environment file happens to be in the root' },
	{ path: '/composer.json', why: 'every module and its exact version' },
	{ path: '/composer.lock', why: 'every dependency and its exact version' },
	{ path: '/var/log/system.log', why: 'what the application last wrote about itself' },
	{ path: '/var/report/', why: 'stack traces, with paths and sometimes payloads' },
	{ path: '/phpinfo.php', why: 'the entire PHP configuration' },
]

/**
 * REST resources and what a caller with no token must get; the public one
 * proves the 401s are authentication rather than the API being down.
 */
export interface RestProbe {
	readonly path: string
	readonly expect: number
	readonly why: string
}

export const REST_PROBES: readonly RestProbe[] = [
	{ path: '/rest/V1/customers/me', expect: 401, why: 'a customer reading their own record' },
	{ path: '/rest/V1/products', expect: 401, why: 'the catalogue write surface' },
	{ path: '/rest/V1/orders', expect: 401, why: 'order data' },
	{ path: '/rest/all/V1/store/storeConfigs', expect: 401, why: 'store configuration' },
	{
		path: '/rest/default/V1/directory/countries',
		expect: 200,
		why: 'a deliberately public resource, proving the API itself answers',
	},
]
