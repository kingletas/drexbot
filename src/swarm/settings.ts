import { existsSync, readFileSync } from 'node:fs'
import { cpus, homedir, totalmem } from 'node:os'
import { join } from 'node:path'

/**
 * The two lists a swarm is not allowed to guess: which stores it may load, and
 * which machines it may start bees on. Both live outside the repository,
 * because they are facts about one operator's estate, and both default to the
 * safe answer: no store at all, and this machine only.
 */

export const configDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
	join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'drexbot')

const lines = (path: string): string[] =>
	existsSync(path)
		? readFileSync(path, 'utf8')
				.split('\n')
				.map(line => line.replace(/#.*/, '').trim())
				.filter(line => line !== '')
		: []

/** Origins the operator has said are theirs to load, one per line in `swarm-targets`. */
export const allowedTargets = (directory: string = configDirectory()): string[] =>
	lines(join(directory, 'swarm-targets')).flatMap(line => {
		try {
			return [new URL(line).origin]
		} catch {
			return []
		}
	})

/** Why a URL may not be loaded, or undefined when it may. Only an exact origin counts. */
export const refusalFor = (url: string, allowed: readonly string[]): string | undefined => {
	let origin: string
	try {
		origin = new URL(url).origin
	} catch {
		return `"${url}" is not a URL`
	}
	if (allowed.includes(origin)) return undefined
	return (
		`${origin} is not in swarm-targets, so it is not a store you have said is yours to load. ` +
		`Add the line "${origin}" to ${join(configDirectory(), 'swarm-targets')} if it is.`
	)
}

export interface BeeHost {
	readonly name: string
	/** DOCKER_HOST for this machine; undefined means the local daemon. */
	readonly dockerHost: string | undefined
	/** The most CPUs and bytes of memory every bee on it may take together. */
	readonly cpus: number
	readonly memory: number
	/** How bees on this host reach the store, when that is not its own URL: a relay, and a Docker network. */
	readonly forward?: string
	readonly network?: string
}

const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }

/** "1.5g" style sizes, as Docker writes them. */
export const bytesOf = (size: string): number => {
	const match = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(size.trim())
	if (match === null) throw new Error(`"${size}" is not a size like 512m or 2g`)
	return Math.round(Number(match[1]) * (UNITS[(match[2] ?? '').toLowerCase()] ?? 1))
}

/**
 * This machine, with half its CPUs and half its memory: a load run should never
 * be the reason the desktop in front of the operator stops answering.
 */
export const localHost = (): BeeHost => ({
	name: 'local',
	dockerHost: undefined,
	cpus: Math.max(1, Math.floor(cpus().length / 2)),
	memory: Math.floor(totalmem() / 2),
})

/**
 * `swarm-hosts`: one machine per line, as `NAME DOCKER_HOST cpus=N memory=SIZE [forward=PORT=HOST:PORT] [network=NAME]`.
 * The budget is required, because the machine is somebody's; `local` with DOCKER_HOST `-` overrides this machine's defaults.
 */
export const beeHosts = (directory: string = configDirectory()): BeeHost[] =>
	lines(join(directory, 'swarm-hosts')).map(line => {
		const [name, dockerHost, ...rest] = line.split(/\s+/)
		const setting = (key: string): string | undefined =>
			rest.find(part => part.startsWith(`${key}=`))?.slice(key.length + 1)
		const cpusSetting = setting('cpus')
		const memorySetting = setting('memory')
		if (name === undefined || dockerHost === undefined || !cpusSetting || !memorySetting) {
			throw new Error(`swarm-hosts: "${line}" needs NAME DOCKER_HOST cpus=N memory=SIZE`)
		}
		const forward = setting('forward')
		const network = setting('network')
		return {
			name,
			dockerHost: dockerHost === '-' ? undefined : dockerHost,
			cpus: Number(cpusSetting),
			memory: bytesOf(memorySetting),
			...(forward === undefined ? {} : { forward }),
			...(network === undefined ? {} : { network }),
		}
	})

export const hostNamed = (name: string, directory: string = configDirectory()): BeeHost => {
	const host = beeHosts(directory).find(candidate => candidate.name === name)
	if (host === undefined && name === 'local') return localHost()
	if (host === undefined) {
		throw new Error(
			`no bee host called "${name}" in ${join(directory, 'swarm-hosts')}; "local" is this machine`,
		)
	}
	return host
}
