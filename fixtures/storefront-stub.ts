import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A defect the stub storefront can be told to have; `error-page-200` is the one
 * worth naming, because a Magento status code alone is not evidence.
 */
export type StoreDefect =
	'none' | 'env-php-served' | 'admin-open' | 'rest-open' | 'error-page-200' | 'no-version'

export interface StorefrontStub {
	readonly url: string
	close(): Promise<void>
}

const LOGIN_PAGE =
	'<!doctype html><html><body class="adminhtml-auth-login">' +
	'<h1>Welcome, please sign in</h1><input name="form_key" value="abc"></body></html>'

const DASHBOARD =
	'<!doctype html><html><body class="adminhtml-dashboard-index">' +
	'<nav class="menu-magento-backend-dashboard">Dashboard</nav>' +
	'<div id="dashboard-advanced-reports">Advanced Reporting</div></body></html>'

const page = (bodyClass: string): string =>
	`<!doctype html><html><body class="page-layout-1column ${bodyClass}">content</body></html>`

/** Routing written out by hand, so it cannot agree with the checks by construction. */
const PAGES = new Map<string, string>([
	['/', page('cms-index-index')],
	['/women/tops-women.html', page('catalog-category-view')],
	['/catalogsearch/result/', page('catalogsearch-result-index')],
	['/checkout/cart/', page('checkout-cart-index')],
	['/customer/account/login/', page('customer-account-login')],
])

const REST_REFUSES = new Set([
	'/rest/V1/customers/me',
	'/rest/V1/products',
	'/rest/V1/orders',
	'/rest/all/V1/store/storeConfigs',
])

export const startStorefrontStub = async (
	defect: StoreDefect = 'none',
): Promise<StorefrontStub> => {
	const handler = (request: IncomingMessage, response: ServerResponse): void => {
		const path = (request.url ?? '/').split('?')[0] ?? '/'

		const send = (status: number, body: string, type = 'text/html'): void => {
			response.writeHead(status, { 'content-type': type })
			response.end(body)
		}

		if (path === '/magento_version') {
			return defect === 'no-version'
				? send(404, 'not found')
				: send(200, 'Magento/2.4 (Enterprise)', 'text/plain')
		}

		if (request.method === 'POST' && path === '/graphql') {
			return send(200, '{"data":{"storeConfig":{"store_code":"default"}}}', 'application/json')
		}

		if (path === '/app/etc/env.php') {
			return defect === 'env-php-served'
				? send(200, "<?php return ['db' => ['password' => 'hunter2']];", 'text/plain')
				: send(404, 'not found')
		}

		if (path.startsWith('/admin')) {
			return defect === 'admin-open' ? send(200, DASHBOARD) : send(200, LOGIN_PAGE)
		}

		if (REST_REFUSES.has(path)) {
			return defect === 'rest-open'
				? send(200, '[{"sku":"WS12"}]', 'application/json')
				: send(401, '{"message":"The consumer isn\'t authorized."}', 'application/json')
		}

		if (path === '/rest/default/V1/directory/countries') {
			return send(200, '[{"id":"AD"}]', 'application/json')
		}

		const body = PAGES.get(path)
		if (body !== undefined) {
			// A 200 carrying an error page rather than the page asked for: the exact
			// case a status-only check calls healthy.
			return defect === 'error-page-200' ? send(200, page('cms-noroute-index')) : send(200, body)
		}

		return send(404, 'not found')
	}

	const server = createServer(handler)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close(error => (error ? reject(error) : resolve())),
			),
	}
}
