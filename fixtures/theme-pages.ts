import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Two storefronts that share no ids and no classes, and a third that has
 * drifted, because portability is not provable by reading a candidate list.
 */
export type Theme =
	| 'semantic'
	| 'themed'
	| 'drifted'
	| 'unrecognisable'
	| 'erroring'
	| 'checkout-shipping'
	| 'checkout-payment'

const SEMANTIC = `<!doctype html><html><body>
  <h1>Search results</h1>
  <form><input type="search" name="query" aria-label="Search"></form>
  <div data-container="product-grid">
    <li><a class="product-item-link" href="/p/1">A shirt</a>
        <span data-price-type="finalPrice">$29.00</span></li>
    <li><a class="product-item-link" href="/p/2">A coat</a>
        <span data-price-type="finalPrice">$99.00</span></li>
  </div>
</body></html>`

const THEMED = `<!doctype html><html><body>
  <div class="page-title"><span>Search results</span></div>
  <form id="search_mini_form"><input name="q"></form>
  <ol class="products"><li class="product-item">
      <div class="product-item-name"><a href="/p/1">A shirt</a></div>
      <div class="price-wrapper"><span class="price">$29.00</span></div>
  </li></ol>
</body></html>`

// Nothing a portable candidate can see: the title is the last entry in its
// list, and the grid only matches the final theme-specific candidate.
const DRIFTED = `<!doctype html><html><body>
  <div class="page-title">Search results</div>
  <form id="search_mini_form"><input name="q"></form>
  <li class="product-item"><a class="product-item-link" href="/p/1">A shirt</a>
      <span class="price">$29.00</span></li>
</body></html>`

const UNRECOGNISABLE = `<!doctype html><html><body>
  <section><span>Some page</span></section>
  <button>Do a thing</button>
  <a href="/elsewhere">Go elsewhere</a>
</body></html>`

// A page telling the shopper what went wrong while the entry a check wants is
// absent, which is the only shape in which the banner is worth reporting.
const ERRORING = `<!doctype html><html><body>
  <div class="page-title">A product</div>
  <div class="messages">
    <div data-ui-id="message-error" class="message message-error error">
      <div>PayPal Checkout could not be initialized. Please contact the store owner.</div>
    </div>
  </div>
  <button id="product-addtocart-button">Add to Cart</button>
</body></html>`

// Luma's one-page checkout renders the payment step into the DOM from the start
// and hides it, so every paymentStep candidate matches on the shipping step.
const checkout = (paymentShown: boolean): string => `<!doctype html><html><body>
  <ol class="opc-progress-bar"><li>Shipping</li><li>Review &amp; Payments</li></ol>
  <ol id="checkoutSteps" class="opc">
    <li id="shipping" class="checkout-shipping-address"${paymentShown ? ' style="display: none;"' : ''}>
      <input id="customer-email" name="username" type="email">
    </li>
    <li id="payment" class="checkout-payment-method"${paymentShown ? '' : ' style="display: none;"'}>
      <div id="checkout-step-payment" class="step-content">
        <div class="payment-method-title"><label>Check / Money order</label></div>
      </div>
    </li>
  </ol>
</body></html>`

const PAGES: Readonly<Record<Theme, string>> = {
	semantic: SEMANTIC,
	themed: THEMED,
	drifted: DRIFTED,
	unrecognisable: UNRECOGNISABLE,
	erroring: ERRORING,
	'checkout-shipping': checkout(false),
	'checkout-payment': checkout(true),
}

export interface ThemeServer {
	readonly url: string
	close(): Promise<void>
}

/** Serves every theme, each at `/<name>`, so one server covers all of them. */
export const startThemeServer = async (): Promise<ThemeServer> => {
	const server = createServer((request, response) => {
		const name = (request.url ?? '/').replace(/^\//, '').split('?')[0] ?? ''
		const body = PAGES[name as Theme]

		response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' })
		response.end(body ?? '<!doctype html><html><body>not found</body></html>')
	})

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
