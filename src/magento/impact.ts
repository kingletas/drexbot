import type { ImpactRule } from 'harness-kernel'

/**
 * What a change to the store puts at risk. The map is always incomplete, so a
 * path matching no rule makes the run fall back to everything.
 */
export const MAGENTO_IMPACT: readonly ImpactRule[] = [
	{
		pattern: /(^|\/)app\/code\/[^/]+\/[^/]+\/view\/frontend\//,
		areas: ['home', 'search', 'category', 'product', 'cart', 'customer-account'],
		why: 'frontend templates and layout reach every storefront page',
	},
	{
		pattern: /(^|\/)app\/design\/frontend\//,
		areas: ['home', 'search', 'category', 'product', 'cart', 'customer-account'],
		why: 'a theme change reaches every storefront page',
	},
	{
		pattern: /Magento_?Catalog|module-catalog(?!-inventory)/i,
		areas: ['search', 'category', 'product'],
		why: 'the catalogue is what a listing and a product page render',
	},
	{
		pattern: /Magento_?Checkout|module-checkout|module-quote/i,
		areas: ['cart', 'checkout'],
		why: 'the quote is the cart',
	},
	{
		pattern: /Magento_?Customer|module-customer/i,
		areas: ['customer-account'],
		why: 'accounts, login and the customer section',
	},
	{
		pattern: /Magento_?Search|module-elasticsearch|module-search/i,
		areas: ['search'],
		why: 'search only',
	},
	{
		pattern: /(^|\/)app\/code\/[^/]+\/[^/]+\/etc\/(webapi|acl)\.xml$/,
		areas: ['rest-api', 'admin'],
		why: 'the REST surface and who may reach it are declared here',
	},
	{
		pattern: /(^|\/)etc\/schema\.graphqls$|GraphQl/,
		areas: ['graphql'],
		why: 'the GraphQL schema',
	},
	{
		pattern: /(^|\/)(nginx|\.htaccess|pub\/\.htaccess)/,
		areas: ['exposure', 'admin'],
		why: 'what the web server will and will not serve',
	},
	{
		pattern: /(^|\/)app\/etc\/(config|env)\.php$/,
		areas: ['home', 'search', 'category', 'product', 'cart', 'admin', 'rest-api', 'graphql'],
		why: 'the module list and the environment reach everything',
	},
]
