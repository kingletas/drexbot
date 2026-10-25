import { cpus, loadavg } from 'node:os'
import type { Docker } from './docker.js'

/**
 * How hard each of the store's services works during a step, against its own
 * CPU cap. The store runs on this machine's Docker as a Compose project, and
 * the service nearest its cap is the one that gives first. The machine's own
 * load is sampled beside it, because a knee found on a busy machine is the
 * machine's, not the store's.
 */

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service'

export interface ServiceLoad {
	readonly service: string
	/** The CPUs Docker caps it at; undefined when it has no cap. */
	readonly capCpus: number | undefined
	/** CPUs in use, one sample at a time. */
	readonly samples: readonly number[]
}

export interface StoreLoad {
	readonly services: readonly ServiceLoad[]
	/** The machine's one-minute load over its cores, one sample at a time. */
	readonly machine: readonly number[]
}

/** CPUs in use by name, from `docker stats --format '{{json .}}'`, where 100% is one CPU. */
export const cpusFromStats = (output: string): Map<string, number> => {
	const used = new Map<string, number>()
	for (const line of output.split('\n')) {
		if (line.trim() === '') continue
		const stat = JSON.parse(line) as { Name: string; CPUPerc: string }
		used.set(stat.Name, Number.parseFloat(stat.CPUPerc) / 100)
	}
	return used
}

const mean = (values: readonly number[]): number =>
	values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** The mean share of its cap each capped service used, busiest first. */
export const againstCaps = (
	load: StoreLoad,
): { readonly service: string; readonly capCpus: number; readonly share: number }[] =>
	load.services
		.flatMap(service =>
			service.capCpus === undefined
				? []
				: [
						{
							service: service.service,
							capCpus: service.capCpus,
							share: mean(service.samples) / service.capCpus,
						},
					],
		)
		.sort((a, b) => b.share - a.share)

export const machineLoad = (load: StoreLoad): number => mean(load.machine)

interface Member {
	readonly name: string
	readonly service: string
	readonly capCpus: number | undefined
}

const membersOf = async (docker: Docker, project: string): Promise<Member[]> => {
	const names = (
		await docker.docker([
			'ps',
			'--filter',
			`label=${COMPOSE_PROJECT_LABEL}=${project}`,
			'--format',
			'{{.Names}}',
		])
	)
		.split('\n')
		.filter(name => name !== '')
	if (names.length === 0)
		throw new Error(`no running container belongs to the Compose project ${project}`)
	const inspected = await docker.docker([
		'inspect',
		'--format',
		`{{.Name}} {{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}} {{.HostConfig.NanoCpus}}`,
		...names,
	])
	return inspected
		.split('\n')
		.filter(line => line !== '')
		.map(line => {
			const [name = '', service = '', nano = '0'] = line.trim().split(' ')
			const capCpus = Number(nano) > 0 ? Number(nano) / 1e9 : undefined
			return { name: name.replace(/^\//, ''), service, capCpus }
		})
}

/**
 * Why a step test cannot read this store as ratios, or undefined when it can:
 * without a CPU cap on any service there is nothing to set the knee against.
 */
export const capsRefusal = async (docker: Docker, project: string): Promise<string | undefined> => {
	const members = await membersOf(docker, project)
	if (members.some(member => member.capCpus !== undefined)) return undefined
	return (
		`no service of the Compose project ${project} has a CPU cap, so its knee could only be a count of users, ` +
		'which means nothing for any other store; give its services a cpus: limit in a Compose file and run again'
	)
}

/** Samples the project's services until stopped; a sample that fails is skipped, not guessed. */
export const sampleStore = async (
	docker: Docker,
	project: string,
	everyMs = 10_000,
): Promise<{ stop(): Promise<StoreLoad> }> => {
	const members = await membersOf(docker, project)
	const samples = new Map<string, number[]>(members.map(member => [member.name, []]))
	const machine: number[] = []
	const cores = cpus().length
	let pending: Promise<void> = Promise.resolve()
	const take = async (): Promise<void> => {
		machine.push((loadavg()[0] ?? 0) / cores)
		try {
			const used = cpusFromStats(
				await docker.docker([
					'stats',
					'--no-stream',
					'--format',
					'{{json .}}',
					...members.map(m => m.name),
				]),
			)
			for (const [name, value] of used) samples.get(name)?.push(value)
		} catch {
			// A container that went away mid-step leaves fewer samples, which the mean reflects.
		}
	}
	const timer = setInterval(() => {
		pending = pending.then(take)
	}, everyMs)
	return {
		stop: async () => {
			clearInterval(timer)
			await pending
			return {
				services: members.map(member => ({
					service: member.service,
					capCpus: member.capCpus,
					samples: samples.get(member.name) ?? [],
				})),
				machine,
			}
		},
	}
}
