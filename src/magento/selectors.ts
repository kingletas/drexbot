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

	sortSelect: ['#sorter', 'select.sorter-options'],

	noResults: ['.message.notice', '.message.empty', 'div.message.info.empty'],
}
