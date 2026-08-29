import type { Candidates, SelectorProfile } from '../surfaces/browser.js'

/**
 * How to find each element the storefront journeys need, ordered most portable
 * first. @see README, "Selectors, and the ledger that watches them rot".
 */
/**
 * How the storefront tells a shopper something, most portable first. Read only
 * when a check could not find what it wanted, and never through the drift
 * ledger — an entry that resolves only on a failure has no comparable history.
 */
export const LUMA_MESSAGES: Candidates = [
	'[data-ui-id^="message-"]',
	'.messages .message',
	'.message.error, .message.success, .message.warning, .message.notice',
]

export const LUMA_PROFILE: SelectorProfile = {
	searchInput: ['input[type="search"]', 'input[name="q"]', '#search'],
	searchSubmit: [
		'role=button[name=/search/i]',
		'button[type="submit"][title*="Search" i]',
		'#search_mini_form button[type="submit"]',
	],
	pageTitle: ['h1', '.page-title span', '.page-title'],
	productTile: [
		'[data-container="product-grid"] li',
		'ol.products li.product-item',
		'li.product-item',
	],
	productLink: ['a.product-item-link', '.product-item-name a'],
	productPrice: ['[data-price-type="finalPrice"]', '.price-wrapper .price', 'span.price'],
	addToCart: [
		'role=button[name=/add to cart/i]',
		'button#product-addtocart-button',
		'button.action.tocart',
	],
	sizeOption: [
		'[data-attribute-code="size"] .swatch-option',
		'.swatch-attribute.size .swatch-option',
	],
	colourOption: [
		'[data-attribute-code="color"] .swatch-option',
		'.swatch-attribute.color .swatch-option',
	],
	minicartToggle: [
		'role=link[name=/my cart/i]',
		'a.action.showcart',
		'[data-block="minicart"] .showcart',
	],
	minicartCounter: ['.counter-number', '.minicart-wrapper .counter.qty'],
	successMessage: ['[data-ui-id="message-success"]', '.message-success', 'div.message.success'],

	productTab: ['role=tab', '.product.data.items > .item.title', '.data.item.title'],
	productTabPanel: ['.product.data.items > .item.content', '.data.item.content'],

	minicartItem: ['.minicart-items .product-item', '#mini-cart .item'],
	minicartSubtotal: ['.minicart-wrapper .subtotal .price', '.block-minicart .subtotal .price'],

	cartRow: ['.cart.item', 'tbody.cart.item'],
	cartQuantity: ['.cart.item input.qty', 'input[name*="[qty]"]'],
	cartUpdate: ['role=button[name=/update shopping cart/i]', 'button[name="update_cart_action"]'],
	cartSubtotal: ['[data-th="Subtotal"] .price', '.cart-summary .grand .price', '.subtotal .price'],

	compareButton: ['role=link[name=/add to compare/i]', 'a.tocompare', '.action.tocompare'],
	compareRow: ['#product-comparison tbody tr', '.table-comparison tbody tr'],
	compareCell: ['#product-comparison .product-item-name', '.table-comparison .product-item-name'],

	paginationNext: ['role=link[name=/next/i]', 'a.action.next', '.pages-item-next a'],
	toolbarAmount: ['#toolbar-amount', '.toolbar-amount'],
	filterTitle: ['.filter-options-title', '[data-role="title"].filter-options-title'],
	filterOption: ['.filter-options-content a', '#narrow-by-list a', '.filter-options-item a'],
	filterActive: ['.filter-current .item', '.filter-current .filter-value'],

	cartRemove: ['role=link[name=/remove item/i]', 'a.action-delete', '.action.action-delete'],
	cartEmpty: ['.cart-empty', '#maincontent .cart-empty p'],
	proceedToCheckout: [
		'role=button[name=/proceed to checkout/i]',
		'button.checkout',
		'.action.primary.checkout',
	],

	wishlistAdd: ['role=link[name=/add to wish list/i]', 'a.action.towishlist', '.action.towishlist'],
	wishlistItem: [
		'.products-grid.wishlist .product-item-name',
		'#wishlist-view-form .product-item-name',
		'.wishlist .product-item-name',
	],
	wishlistEmpty: ['.wishlist .message.info.empty', '#wishlist-view-form .message.info.empty'],

	registerLink: ['role=link[name=/create an account/i]', 'a[href*="customer/account/create"]'],
	firstName: ['#firstname', 'input[name="firstname"]'],
	lastName: ['#lastname', 'input[name="lastname"]'],
	emailField: ['#email_address', 'input[name="email"]', '#customer-email'],
	passwordField: ['#password', 'input[name="password"]'],
	passwordConfirm: ['#password-confirmation', 'input[name="password_confirmation"]'],
	registerSubmit: ['role=button[name=/create an account/i]', 'button.submit', '.action.submit'],
	accountGreeting: ['.box-information .box-content', '.welcome', '.logged-in'],

	checkoutEmail: ['#customer-email', 'input[name="username"]'],
	streetLine: ['input[name="street[0]"]', '.field.street input'],
	city: ['input[name="city"]', '#city'],
	postcode: ['input[name="postcode"]', '#postcode'],
	region: ['select[name="region_id"]', '#region_id'],
	telephone: ['input[name="telephone"]', '#telephone'],
	shippingMethod: [
		'.table-checkout-shipping-method input[type="radio"]',
		'#checkout-shipping-method-load input',
	],
	checkoutNext: ['role=button[name=/next/i]', 'button.continue', '.button.action.continue'],
	paymentStep: ['#checkout-step-payment', '.checkout-payment-method', '#payment'],
	paymentMethodTitle: ['.payment-method-title label', '.payment-group .payment-method-title'],
	paymentMethod: [
		'#co-payment-form input[type="radio"][name="payment[method]"]',
		'.payment-methods input[type="radio"]',
	],
	paymentUnavailable: ['.no-quotes-block', '.checkout-payment-method .message.notice'],
	placeOrder: [
		'role=button[name=/place order/i]',
		'.payment-method._active button.action.primary.checkout',
		'#co-payment-form button.action.primary.checkout',
	],
	checkoutSuccess: ['.checkout-success', '.checkout-onepage-success .column.main'],

	orderLookupId: ['#oar-order-id', 'input[name="oar_order_id"]'],
	orderLookupLastName: ['#oar-billing-lastname', 'input[name="oar_billing_lastname"]'],
	orderLookupEmail: ['#oar_email', 'input[name="oar_email"]'],
	orderLookupSubmit: [
		'#oar-widget-orders-and-returns-form >> role=button[name=/continue/i]',
		'#oar-widget-orders-and-returns-form button[type="submit"]',
		'.form-orders-search button.action.submit',
	],

	sortSelect: ['#sorter', 'select.sorter-options'],

	noResults: ['.message.notice', '.message.empty', 'div.message.info.empty'],
}
