import type { Docker } from './docker.js'
import type { BeeOrder } from './plan.js'
import { BEE_LABEL, RUN_LABEL } from './docker.js'

/**
 * Starts bees as ECS tasks on a local emulator only: any other endpoint is refused before a byte is sent, and nothing is signed.
 * An emulator ignores a task's limits and leaves its containers behind, so each container is capped here and teardown is checked in Docker.
 */

export const CLUSTER = 'drexbot-swarm'
const EMULATOR_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '172.17.0.1'])
const TASK_LABEL = 'com.amazonaws.ecs.task-arn'

/** Why an endpoint may not be used, or undefined for a local emulator. */
export const emulatorRefusal = (endpoint: string | undefined): string | undefined => {
	if (endpoint === undefined || endpoint === '') {
		return 'DREXBOT_ECS_ENDPOINT is not set; it must name a local ECS emulator such as http://127.0.0.1:4566'
	}
	let url: URL
	try {
		url = new URL(endpoint)
	} catch {
		return `DREXBOT_ECS_ENDPOINT "${endpoint}" is not a URL`
	}
	if (url.protocol !== 'http:' || !EMULATOR_HOSTS.has(url.hostname)) {
		return (
			`${url.origin} is not a local emulator, and this tool never calls AWS. ` +
			'For real AWS, run `drexbot swarm aws` and hand the commands to someone who may run them.'
		)
	}
	return undefined
}

export class EcsEmulator {
	private readonly taskDefinitions: string[] = []
	private readonly tasks: string[] = []

	constructor(
		private readonly endpoint: string,
		private readonly docker: Docker,
	) {
		const refusal = emulatorRefusal(endpoint)
		if (refusal !== undefined) throw new Error(refusal)
	}

	private async call<T>(operation: string, body: object): Promise<T> {
		const date = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
		const response = await fetch(this.endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-amz-json-1.1',
				'x-amz-target': `AmazonEC2ContainerServiceV20141113.${operation}`,
				'x-amz-date': date,
				// Emulators route on the service named here; the signature is deliberately not one.
				authorization: `AWS4-HMAC-SHA256 Credential=test/${date.slice(0, 8)}/us-east-1/ecs/aws4_request, SignedHeaders=host, Signature=unsigned`,
			},
			body: JSON.stringify(body),
		})
		const text = await response.text()
		if (!response.ok) throw new Error(`ECS ${operation} was refused: ${text.slice(0, 300)}`)
		return JSON.parse(text || '{}') as T
	}

	/** One task definition per bee, because each bee's orders differ and overrides are not relied on. */
	async start(run: string, bee: BeeOrder): Promise<string> {
		await this.call('CreateCluster', { clusterName: CLUSTER })
		const registered = await this.call<{ taskDefinition: { taskDefinitionArn: string } }>(
			'RegisterTaskDefinition',
			{
				family: `drexbot-${run}-${bee.id}`,
				requiresCompatibilities: ['EC2'],
				networkMode: 'bridge',
				cpu: String(Math.round(bee.cpus * 1024)),
				memory: String(Math.round(bee.memory / 1024 ** 2)),
				containerDefinitions: [
					{
						name: 'bee',
						image: bee.image,
						essential: true,
						cpu: Math.round(bee.cpus * 1024),
						memory: Math.round(bee.memory / 1024 ** 2),
						environment: Object.entries(bee.env).map(([name, value]) => ({ name, value })),
						dockerLabels: { [RUN_LABEL]: run, [BEE_LABEL]: bee.id },
					},
				],
			},
		)
		const arn = registered.taskDefinition.taskDefinitionArn
		this.taskDefinitions.push(arn)
		const started = await this.call<{ tasks?: { taskArn: string }[]; failures?: unknown[] }>(
			'RunTask',
			{ cluster: CLUSTER, taskDefinition: arn, count: 1, launchType: 'EC2', startedBy: run },
		)
		const task = started.tasks?.[0]?.taskArn
		if (task === undefined) {
			throw new Error(
				`ECS started no task for ${bee.id}: ${JSON.stringify(started.failures ?? [])}`,
			)
		}
		this.tasks.push(task)
		return this.capWhenItAppears(task, bee)
	}

	private async capWhenItAppears(task: string, bee: BeeOrder): Promise<string> {
		const giveUp = Date.now() + 60_000
		while (Date.now() < giveUp) {
			const [container] = await this.docker.list(`${TASK_LABEL}=${task}`)
			if (container !== undefined) {
				await this.docker.cap(container.id, bee.cpus, bee.memory)
				return container.id
			}
			await new Promise(resolve => setTimeout(resolve, 250))
		}
		throw new Error(
			`the emulator accepted task ${task} for ${bee.id} but started no container within a minute`,
		)
	}

	/** Asks the emulator to forget what it was told; the containers are removed in Docker, where it counts. */
	async cleanup(): Promise<void> {
		for (const task of this.tasks) {
			await this.call('StopTask', {
				cluster: CLUSTER,
				task,
				reason: 'drexbot swarm run finished',
			}).catch(() => undefined)
		}
		for (const arn of this.taskDefinitions) {
			await this.call('DeregisterTaskDefinition', { taskDefinition: arn }).catch(() => undefined)
		}
	}
}

export const ECS_CLUSTER_LABEL = 'com.amazonaws.ecs.cluster'
