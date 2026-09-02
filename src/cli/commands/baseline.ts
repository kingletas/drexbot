import { join } from 'node:path'
import { discoverStore, saveStore } from '../../magento/baseline.js'
import { HttpSurface, type Harness, type Options } from '@harness/kernel'

/**
 * Captures what a store is over GraphQL, read-only, so the checks stop
 * assuming: a category path and a search term are facts, not constants.
 */
export const captureBaseline = async (harness: Harness, options: Options): Promise<number> => {
	if (options.target !== 'magento') {
		process.stderr.write('drexbot: only the magento target has a store to baseline\n')
		return 2
	}

	const baseUrl = options.url ?? process.env['MAGENTO_URL'] ?? 'https://vanilla.test'
	const environment = options.environment ?? 'local'
	const path = join(harness.workspace.baselines, `magento--${environment}.store.json`)

	try {
		const store = await discoverStore(new HttpSurface(baseUrl, 30_000), baseUrl)
		saveStore(path, store)

		process.stdout.write(`\n  ${baseUrl} — store "${store.storeCode}", ${store.currency}\n`)
		process.stdout.write(
			`  category   ${store.categoryPath}  (${store.categoryProducts} products)\n`,
		)
		process.stdout.write(`  search     "${store.searchTerm}"  (${store.searchResults} results)\n`)
		process.stdout.write(
			`  product    ${store.configurableProductPath ?? store.simpleProductPath ?? 'none found'}` +
				`${store.configurableProductPath === undefined ? '  — no product with options, so swatch journeys cannot run here' : ''}\n`,
		)
		process.stdout.write(`\n  written to ${path.replace(harness.workspace.root, '.')}\n\n`)
		return 0
	} catch (cause) {
		process.stderr.write(
			`drexbot: could not baseline ${baseUrl} — ${cause instanceof Error ? cause.message : String(cause)}\n`,
		)
		return 1
	}
}
