import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PreconditionFailure } from 'harness-kernel'
import type { HttpSurface } from 'harness-kernel'

/**
 * What this particular store is — data the checks read, not a report, because a
 * category path written into the source pins the harness to one catalogue.
 */
export interface StoreBaseline {
	/** False for the stand-in used before anything has been captured. */
	readonly captured: boolean
	readonly capturedAt: string
	readonly baseUrl: string
	readonly storeCode: string
	readonly currency: string
	/** A category that actually has products in it, with its suffix applied. */
	readonly categoryPath: string
	readonly categoryProducts: number
	/** A term this catalogue returns results for. */
	readonly searchTerm: string
	readonly searchResults: number
	/** A product with options, or absent when the catalogue has none. */
	readonly configurableProductPath?: string
	readonly simpleProductPath?: string
}

interface GraphQlError {
	readonly message: string
}

const query = async <T>(http: HttpSurface, gql: string): Promise<T> => {
	const response = await http.send({
		method: 'POST',
		path: '/graphql',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: gql }),
	})

	const payload = JSON.parse(response.body || '{}') as { data?: T; errors?: GraphQlError[] }
	if (payload.errors !== undefined || payload.data === undefined) {
		throw new PreconditionFailure(
			`GraphQL refused the query: ${payload.errors?.[0]?.message ?? response.body.slice(0, 160)}`,
		)
	}
	return payload.data
}

interface CategoryNode {
	readonly uid: string
	readonly name: string
	readonly url_path: string | null
	readonly product_count: number
	readonly children?: readonly CategoryNode[]
}

const flatten = (nodes: readonly CategoryNode[] | undefined): CategoryNode[] =>
	(nodes ?? []).flatMap(node => [node, ...flatten(node.children)])

/**
 * A word worth searching for, taken from a product this catalogue has rather
 * than guessed — a store selling nothing called "bag" is not a broken store.
 */
const searchWordsFrom = (names: readonly string[]): readonly string[] => [
	...new Set(
		names
			.flatMap(name => name.split(/\s+/))
			.map(word => word.replace(/[^a-zA-Z]/g, '').toLowerCase())
			.filter(word => word.length >= 4),
	),
]

/** Asks the store what it is. Read-only, and over GraphQL rather than a browser. */
export const discoverStore = async (http: HttpSurface, baseUrl: string): Promise<StoreBaseline> => {
	const config = await query<{
		storeConfig: {
			store_code: string
			category_url_suffix: string
			product_url_suffix: string
			default_display_currency_code: string
		}
	}>(
		http,
		'{storeConfig{store_code category_url_suffix product_url_suffix default_display_currency_code}}',
	)

	const tree = await query<{ categoryList: readonly CategoryNode[] }>(
		http,
		'{categoryList(filters:{}){uid name url_path product_count children{uid name url_path product_count children{uid name url_path product_count}}}}',
	)

	// The busiest category rather than the first: a listing check wants a page
	// with products on it, and the root of a Magento tree usually has none.
	const category = flatten(tree.categoryList)
		.filter(node => node.url_path !== null && node.product_count > 0)
		.sort((left, right) => right.product_count - left.product_count)[0]

	if (category === undefined) {
		throw new PreconditionFailure('no category in this store has any products in it')
	}

	const listing = await query<{
		products: {
			total_count: number
			items: readonly { url_key: string; name: string; __typename: string }[]
		}
	}>(
		http,
		`{products(filter:{category_uid:{eq:"${category.uid}"}},pageSize:20){total_count items{url_key name __typename}}}`,
	)

	const configurable = listing.products.items.find(
		item => item.__typename === 'ConfigurableProduct',
	)
	const simple = listing.products.items.find(item => item.__typename === 'SimpleProduct')

	let searchTerm = ''
	let searchResults = 0
	for (const word of searchWordsFrom(listing.products.items.map(item => item.name))) {
		const found = await query<{ products: { total_count: number } }>(
			http,
			`{products(search:"${word}",pageSize:1){total_count}}`,
		)
		if (found.products.total_count > 0) {
			searchTerm = word
			searchResults = found.products.total_count
			break
		}
	}

	if (searchTerm === '') {
		throw new PreconditionFailure('no word from this catalogue returns any search results')
	}

	const productPath = (key: string | undefined): string | undefined =>
		key === undefined ? undefined : `/${key}${config.storeConfig.product_url_suffix}`

	return {
		captured: true,
		capturedAt: new Date().toISOString(),
		baseUrl,
		storeCode: config.storeConfig.store_code,
		currency: config.storeConfig.default_display_currency_code,
		categoryPath: `/${category.url_path ?? ''}${config.storeConfig.category_url_suffix}`,
		categoryProducts: category.product_count,
		searchTerm,
		searchResults,
		...(configurable === undefined
			? {}
			: { configurableProductPath: productPath(configurable.url_key) }),
		...(simple === undefined ? {} : { simpleProductPath: productPath(simple.url_key) }),
	}
}

export const loadStore = (path: string): StoreBaseline | undefined => {
	if (!existsSync(path)) return undefined
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as StoreBaseline
	} catch {
		return undefined
	}
}

export const saveStore = (path: string, baseline: StoreBaseline): void => {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(baseline, null, '\t')}\n`, 'utf8')
}

/** Named once, so every check that needs a catalogue asks for it the same way. */
export const NO_BASELINE =
	'no store baseline has been captured — run: drexbot baseline --target magento'

/**
 * The stand-in used before anything has been captured; its `captured` flag is
 * what the checks read, because a guessed path fails as though the store were broken.
 */
export const uncapturedStore = (baseUrl: string): StoreBaseline => ({
	captured: false,
	capturedAt: 'never',
	baseUrl,
	storeCode: 'unknown',
	currency: 'unknown',
	categoryPath: '/',
	categoryProducts: 0,
	searchTerm: '',
	searchResults: 0,
})
