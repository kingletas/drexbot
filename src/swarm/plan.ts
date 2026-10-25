import { randomBytes } from 'node:crypto'
import type { StoreBaseline } from '../magento/baseline.js'
import type { BeeKind } from '../bee/lines.js'
import { MIXES, type MixName } from '../bee/mix.js'
import type { BeeHost } from './settings.js'

/**
 * A run decided before anything starts: which bees, how big, where, and for how
 * long. Everything that can refuse a run refuses it here, while refusing still
 * costs nothing.
 */

export interface Stage {
	readonly stage: string
	readonly path: string
}

export interface Shape {
	readonly browser: {
		readonly bees: number
		readonly workers: number
		readonly cpus: number
		readonly memory: number
	}
	readonly protocol: {
		readonly bees: number
		readonly users: number
		readonly cpus: number
		readonly memory: number
	}
	readonly seconds: number
	/** Which journeys the bees' shoppers take; unset, they browse as they always have. */
	readonly mix?: MixName
}

export interface BeeOrder {
	readonly id: string
	readonly kind: BeeKind
	readonly image: string
	readonly concurrency: number
	readonly cpus: number
	readonly memory: number
	readonly env: Readonly<Record<string, string>>
}

export type Via = 'docker' | 'ecs'

export interface RunPlan {
	readonly run: string
	readonly url: string
	readonly stages: readonly Stage[]
	readonly host: BeeHost
	readonly via: Via
	readonly shape: Shape
	readonly bees: readonly BeeOrder[]
	/** Hard limit on each bee's life: its load, its browser's start, and time to write its last lines. */
	readonly lifetime: number
	readonly storeCpus?: number
}

/** The pages both kinds of bee walk, read from the store's own baseline. */
export const stagesOf = (store: StoreBaseline): Stage[] => {
	const product = store.configurableProductPath ?? store.simpleProductPath
	return [
		{ stage: 'home', path: '/' },
		{ stage: 'category', path: store.categoryPath },
		...(store.searchTerm === ''
			? []
			: [
					{
						stage: 'search',
						path: `/catalogsearch/result/?q=${encodeURIComponent(store.searchTerm)}`,
					},
				]),
		...(product === undefined ? [] : [{ stage: 'product', path: product }]),
	]
}

/** Two runs are comparable when this matches: same bees, same sizes, same length, same machine. */
export const shapeKey = (shape: Shape, host: string, via: Via): string =>
	[
		`browser ${shape.browser.bees}x${shape.browser.workers}@${shape.browser.cpus}cpu`,
		`protocol ${shape.protocol.bees}x${shape.protocol.users}@${shape.protocol.cpus}cpu`,
		`${shape.seconds}s`,
		...(shape.mix === undefined || shape.mix === 'browse' ? [] : [`mix ${shape.mix}`]),
		`${host}/${via}`,
	].join(', ')

export const runId = (now: Date = new Date()): string =>
	`${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`

export interface PlanInput {
	readonly url: string
	readonly stages: readonly Stage[]
	readonly host: BeeHost
	readonly via: Via
	readonly shape: Shape
	readonly images: { readonly browser: string; readonly protocol: string }
	/** "PORT=HOST:PORT ..." for each bee's relay, when the store is not reachable as its own URL. */
	readonly forward?: string
	readonly run?: string
	/** Put before every bee's id when one run spans several hosts, so no two bees share one. */
	readonly beePrefix?: string
	/** The product page a browser bee's cart or order journey buys. */
	readonly cartPath?: string
	/** The simple product a protocol bee's cart or order journey adds over REST. */
	readonly cartSku?: string
	/** The store said it may take orders: `MAGENTO_DISPOSABLE=1`, read by the caller. */
	readonly disposable?: boolean
	/** The CPUs the store itself is capped at, when the operator knows them, so orders can be read per core. */
	readonly storeCpus?: number
}

/** The plan, or the reason there cannot be one. */
export const planRun = (input: PlanInput): RunPlan | string => {
	const { shape, host } = input
	if (shape.browser.bees + shape.protocol.bees === 0) return 'a run needs at least one bee'
	if (shape.seconds < 10) return 'a run needs at least 10 seconds of load to say anything'
	const mix = MIXES[shape.mix ?? 'browse']
	if (mix.browse < 1 && shape.browser.bees > 0 && input.cartPath === undefined) {
		return `the ${shape.mix ?? ''} mix puts products in carts, and the store baseline names no product to buy`
	}
	if (mix.browse < 1 && shape.protocol.bees > 0 && input.cartSku === undefined) {
		return (
			`the ${shape.mix ?? ''} mix has protocol bees add a product to a cart over REST by SKU, ` +
			'and the store baseline holds none; give the SKU of a simple product in stock with --sku ' +
			"(a baseline captured again finds one only when the first category's first page lists one)"
		)
	}
	if (mix.order > 0 && input.disposable !== true) {
		return (
			`the ${shape.mix ?? ''} mix places orders, which nothing here can take back; ` +
			'set MAGENTO_DISPOSABLE=1 only for a store you would not mind finding test orders in'
		)
	}

	const cpus = shape.browser.bees * shape.browser.cpus + shape.protocol.bees * shape.protocol.cpus
	const memory =
		shape.browser.bees * shape.browser.memory + shape.protocol.bees * shape.protocol.memory
	if (cpus > host.cpus || memory > host.memory) {
		return (
			`these bees need ${cpus} CPUs and ${gib(memory)}, and ${host.name} allows ${host.cpus} CPUs ` +
			`and ${gib(host.memory)}. Use fewer or smaller bees, or raise the budget in swarm-hosts.`
		)
	}

	const run = input.run ?? runId()
	// Starting Chromium and writing the last window both fall outside the load, so
	// the bee is given room for them, and for a checkout begun just before the end.
	const lifetime = shape.seconds + (mix.browse < 1 ? 180 : 60)
	const common = {
		BEE_RUN: run,
		BEE_URL: input.url,
		BEE_PATHS: JSON.stringify(input.stages),
		BEE_SECONDS: String(shape.seconds),
		BEE_LIFETIME: String(lifetime),
		...(input.forward === undefined ? {} : { BEE_FORWARD: input.forward }),
		...(shape.mix === undefined ? {} : { BEE_MIX: shape.mix }),
		...(input.cartPath === undefined || mix.browse === 1 ? {} : { BEE_CART_PATH: input.cartPath }),
		...(mix.order > 0 ? { BEE_DISPOSABLE: '1' } : {}),
	}
	const order = (kind: BeeKind, n: number): BeeOrder => {
		const size = kind === 'browser' ? shape.browser : shape.protocol
		const concurrency = kind === 'browser' ? shape.browser.workers : shape.protocol.users
		const id = `${input.beePrefix === undefined ? '' : `${input.beePrefix}-`}${kind}-${n + 1}`
		return {
			id,
			kind,
			image: input.images[kind],
			concurrency,
			cpus: size.cpus,
			memory: size.memory,
			env: {
				...common,
				BEE_ID: id,
				BEE_CONCURRENCY: String(concurrency),
				...(kind === 'protocol' && input.cartSku !== undefined && mix.browse < 1
					? { BEE_CART_SKU: input.cartSku }
					: {}),
			},
		}
	}

	return {
		run,
		url: input.url,
		stages: input.stages,
		host,
		via: input.via,
		shape,
		bees: [
			...Array.from({ length: shape.browser.bees }, (_, n) => order('browser', n)),
			...Array.from({ length: shape.protocol.bees }, (_, n) => order('protocol', n)),
		],
		lifetime,
		...(input.storeCpus === undefined ? {} : { storeCpus: input.storeCpus }),
	}
}
