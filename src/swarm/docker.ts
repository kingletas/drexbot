import { execFile } from 'node:child_process'
import type { BeeHost } from './settings.js'
import type { BeeOrder } from './plan.js'

/**
 * The Docker CLI, pointed at one bee host. DOCKER_HOST=ssh://... reaches
 * another machine's daemon through SSH, so nothing on that machine listens on
 * the network for this.
 */

export const RUN_LABEL = 'drexbot.swarm.run'
export const BEE_LABEL = 'drexbot.swarm.bee'

export interface Container {
	readonly id: string
	readonly name: string
	readonly running: boolean
	readonly labels: Readonly<Record<string, string>>
}

export class Docker {
	constructor(readonly host: BeeHost) {}

	/** Runs `docker ARGS`, and throws with Docker's own message when it fails. */
	async docker(args: readonly string[], input?: string): Promise<string> {
		const env = { ...process.env }
		if (this.host.dockerHost === undefined) delete env['DOCKER_HOST']
		else env['DOCKER_HOST'] = this.host.dockerHost
		return new Promise((resolve, reject) => {
			const child = execFile(
				'docker',
				[...args],
				{ env, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 },
				(error, stdout, stderr) => {
					if (error === null) resolve(stdout)
					else
						reject(
							new Error(
								`docker ${args[0] ?? ''} on ${this.host.name}: ${stderr.trim() || error.message}`,
							),
						)
				},
			)
			if (input !== undefined) child.stdin?.end(input)
		})
	}

	async hasImage(image: string): Promise<boolean> {
		return this.docker(['image', 'inspect', '--format', '{{.Id}}', image]).then(
			() => true,
			() => false,
		)
	}

	/** Starts one bee with its caps set at creation, so it never runs a moment uncapped. */
	async start(run: string, bee: BeeOrder, network?: string): Promise<string> {
		const env = Object.entries(bee.env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
		const out = await this.docker([
			'run',
			'--detach',
			'--name',
			`drexbot-${run}-${bee.id}`,
			'--label',
			`${RUN_LABEL}=${run}`,
			'--label',
			`${BEE_LABEL}=${bee.id}`,
			'--cpus',
			String(bee.cpus),
			'--memory',
			String(bee.memory),
			'--memory-swap',
			String(bee.memory),
			'--pids-limit',
			'2048',
			...(bee.kind === 'browser' ? ['--shm-size', '512m'] : []),
			...(network === undefined ? [] : ['--network', network]),
			...env,
			bee.image,
		])
		return out.trim()
	}

	/** Caps a container something else started, as ECS would have from its task definition. */
	async cap(id: string, cpus: number, memory: number): Promise<void> {
		await this.docker([
			'update',
			'--cpus',
			String(cpus),
			'--memory',
			String(memory),
			'--memory-swap',
			String(memory),
			id,
		])
	}

	async list(label: string): Promise<Container[]> {
		const out = await this.docker([
			'ps',
			'--all',
			'--no-trunc',
			'--filter',
			`label=${label}`,
			'--format',
			'{{json .}}',
		])
		return out
			.split('\n')
			.filter(line => line.trim() !== '')
			.map(line => {
				const raw = JSON.parse(line) as { ID: string; Names: string; State: string; Labels: string }
				return {
					id: raw.ID,
					name: raw.Names,
					running: raw.State === 'running' || raw.State === 'created' || raw.State === 'restarting',
					labels: Object.fromEntries(
						raw.Labels.split(',')
							.filter(pair => pair.includes('='))
							.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
					),
				}
			})
	}

	/** Which of these containers are still running; a container that no longer exists is not. */
	async running(ids: readonly string[]): Promise<Set<string>> {
		const alive = new Set<string>()
		for (const id of ids) {
			const state = await this.docker([
				'container',
				'inspect',
				'--format',
				'{{.State.Running}}',
				id,
			]).catch(() => 'false')
			if (state.trim() === 'true') alive.add(id)
		}
		return alive
	}

	async logs(id: string): Promise<string> {
		return this.docker(['logs', id])
	}

	async remove(ids: readonly string[]): Promise<void> {
		if (ids.length > 0) await this.docker(['rm', '--force', ...ids])
	}
}
