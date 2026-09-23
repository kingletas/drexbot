/**
 * What a bee is told, through its environment only. Environment variables are
 * the one input that reaches a container the same way under Docker, under ECS
 * and under an emulator of ECS, so nothing else is read.
 */
export interface BeeConfig {
	readonly run: string
	readonly bee: string
	/** The store's base URL, as the store itself expects to be addressed. */
	readonly url: string
	readonly paths: readonly { readonly stage: string; readonly path: string }[]
	/** Browser workers, or protocol virtual users. */
	readonly concurrency: number
	/** Seconds of load, counted from when the bee is ready rather than from when it started. */
	readonly seconds: number
	readonly windowSeconds: number
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
	const value = env[name]
	if (value === undefined || value === '') throw new Error(`${name} is not set`)
	return value
}

const positive = (env: NodeJS.ProcessEnv, name: string, fallback?: number): number => {
	const raw = env[name]
	const value = raw === undefined || raw === '' ? fallback : Number(raw)
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number, not "${raw ?? ''}"`)
	}
	return value
}

/** Reads the bee's orders, and throws with the variable's name when one is missing or wrong. */
export const readBeeConfig = (env: NodeJS.ProcessEnv): BeeConfig => {
	const paths = JSON.parse(required(env, 'BEE_PATHS')) as unknown
	if (
		!Array.isArray(paths) ||
		paths.length === 0 ||
		!paths.every(
			(entry: unknown) =>
				typeof (entry as { stage?: unknown }).stage === 'string' &&
				typeof (entry as { path?: unknown }).path === 'string',
		)
	) {
		throw new Error('BEE_PATHS must be a non-empty JSON list of {stage, path}')
	}
	return {
		run: required(env, 'BEE_RUN'),
		bee: required(env, 'BEE_ID'),
		url: new URL(required(env, 'BEE_URL')).href,
		paths: paths as BeeConfig['paths'],
		concurrency: Math.floor(positive(env, 'BEE_CONCURRENCY')),
		seconds: positive(env, 'BEE_SECONDS'),
		windowSeconds: positive(env, 'BEE_WINDOW_SECONDS', 10),
	}
}
