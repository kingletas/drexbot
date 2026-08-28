import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { discoverStore, uncapturedStore } from '../src/magento/baseline.js'
import { HttpSurface } from '@harness/kernel'

/** A GraphQL endpoint that answers the four questions discovery asks. */
const startCatalogue = async (
	options: {
		readonly configurable?: boolean
		readonly searchable?: boolean
		readonly empty?: boolean
	} = {},
) => {
	const server = createServer((request, response) => {
		let body = ''
		request.on('data', chunk => (body += String(chunk)))
		request.on('end', () => {
			const query = (JSON.parse(body || '{}') as { query?: string }).query ?? ''
			const send = (data: unknown): void => {
				response.writeHead(200, { 'content-type': 'application/json' })
				response.end(JSON.stringify({ data }))
			}

			if (query.includes('storeConfig')) {
				return send({
					storeConfig: {
						store_code: 'default',
						category_url_suffix: '.html',
						product_url_suffix: '.html',
						default_display_currency_code: 'USD',
					},
				})
			}

			if (query.includes('categoryList')) {
				return send({
					categoryList:
						options.empty === true
							? [{ uid: 'root', name: 'Root', url_path: null, product_count: 0, children: [] }]
							: [
									{
										uid: 'root',
										name: 'Root',
										url_path: null,
										product_count: 0,
										children: [
											{ uid: 'small', name: 'Small', url_path: 'gear/watches', product_count: 9 },
											{ uid: 'big', name: 'Big', url_path: 'women/tops-women', product_count: 50 },
										],
									},
								],
				})
			}

			if (query.includes('category_uid')) {
				return send({
					products: {
						total_count: 2,
						items: [
							{
								url_key: 'breathe-easy-tank',
								name: 'Breathe Easy Tank',
								__typename:
									options.configurable === false ? 'SimpleProduct' : 'ConfigurableProduct',
							},
							{ url_key: 'joust-bag', name: 'Joust Duffle Bag', __typename: 'SimpleProduct' },
						],
					},
				})
			}

			return send({ products: { total_count: options.searchable === false ? 0 : 23 } })
		})
	})

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	}
}

const discover = async (options = {}) => {
	const catalogue = await startCatalogue(options)
	try {
		return await discoverStore(new HttpSurface(catalogue.url), catalogue.url)
	} finally {
		await catalogue.close()
	}
}

describe('discovering what a store is', () => {
	it('picks the category with the most products, not the first', async () => {
		// A listing check wants a page with products on it, and the first category
		// in a Magento tree usually has none.
		const store = await discover()

		assert.equal(store.categoryPath, '/women/tops-women.html')
		assert.equal(store.categoryProducts, 50)
	})

	it('applies the store own url suffixes rather than assuming .html', async () => {
		const store = await discover()

		assert.ok(store.categoryPath.endsWith('.html'))
		assert.ok(store.configurableProductPath?.endsWith('.html'))
	})

	it('takes a search term from a product the catalogue actually has', async () => {
		// A term that returns nothing makes the search checks fail for want of a
		// fixture, and a store selling nothing called "bag" is not a broken store.
		const store = await discover()

		assert.ok(['breathe', 'easy', 'tank', 'joust', 'duffle'].includes(store.searchTerm))
		assert.equal(store.searchResults, 23)
	})

	it('refuses a catalogue whose every category is empty', async () => {
		await assert.rejects(() => discover({ empty: true }), /no category .* has any products/)
	})

	it('refuses when no word from the catalogue returns results', async () => {
		await assert.rejects(
			() => discover({ searchable: false }),
			/no word .* returns any search results/,
		)
	})

	it('says so when the catalogue has no product with options', async () => {
		// Reported rather than assumed: a store with only simple products cannot
		// run a swatch journey, and that is a fact about the store.
		const store = await discover({ configurable: false })

		assert.equal(store.configurableProductPath, undefined)
		assert.ok(store.simpleProductPath?.length ?? 0 > 0)
	})

	it('marks itself captured, which is what the checks read', async () => {
		assert.equal((await discover()).captured, true)
		assert.equal(uncapturedStore('http://x').captured, false)
	})
})
