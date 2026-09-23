import { beeLinesIn, type BeeLine } from '../bee/lines.js'
import { RUN_LABEL, type Docker } from './docker.js'
import { EcsEmulator } from './ecs.js'
import { shapeKey, type BeeOrder, type RunPlan } from './plan.js'
import { reconcile } from './reconcile.js'
import type { RunRecord, Teardown } from './record.js'
import { RECORD_TAG } from './record.js'

/**
 * Runs a plan from start to verified teardown. Teardown sits in a `finally`,
 * so a bee that fails to start, an error while waiting, or Ctrl-C all end the
 * same way: every container of the run removed, and the removal checked.
 * If this process is killed outright, each bee still stops at its own
 * lifetime, and `drexbot swarm sweep` removes what is left.
 */

export interface Launcher {
	start(run: string, bee: BeeOrder): Promise<string>
	cleanup(): Promise<void>
}

export const dockerLauncher = (docker: Docker, network?: string): Launcher => ({
	start: async (run, bee) => docker.start(run, bee, network),
	cleanup: () => Promise.resolve(),
})

export const ecsLauncher = (endpoint: string, docker: Docker): Launcher => {
	const ecs = new EcsEmulator(endpoint, docker)
	return { start: async (run, bee) => ecs.start(run, bee), cleanup: async () => ecs.cleanup() }
}

export interface Progress {
	(message: string): void
}

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** What one host's part of a run left: its bees' lines, its teardown, and what a reader must know. */
interface HostOutcome {
	readonly host: string
	readonly startedAt: string
	readonly lines: readonly BeeLine[]
	readonly teardown: Teardown
	readonly caveats: readonly string[]
	/** Seconds of load it actually had, which is less than planned when it was stopped. */
	readonly seconds: number
}

export interface HostRun {
	readonly plan: RunPlan
	readonly docker: Docker
	readonly launcher: Launcher
}

const conductHost = async (
	{ plan, docker, launcher }: HostRun,
	say: Progress,
	stop: { requested: boolean },
): Promise<HostOutcome> => {
	const startedAt = new Date().toISOString()
	const started: { bee: BeeOrder; id: string }[] = []
	const caveats: string[] = []
	let lines: BeeLine[] = []
	let teardown: Teardown = { removed: 0, leftover: 0, verified: false }
	// A run stopped early is measured over the load it had, not the load it was planned to have.
	let seconds = plan.shape.seconds

	try {
		for (const bee of plan.bees) {
			if (stop.requested) break
			started.push({ bee, id: await launcher.start(plan.run, bee) })
			say(
				`started ${bee.id} on ${plan.host.name}: ${bee.concurrency} ${bee.kind === 'browser' ? 'workers' : 'users'}, ${bee.cpus} CPU`,
			)
		}

		// Each bee ends itself; the wait is only as long as the longest a bee may live, plus a little.
		const loadStarted = Date.now()
		const giveUp = loadStarted + (plan.lifetime + 30) * 1_000
		while (!stop.requested && Date.now() < giveUp) {
			if ((await docker.running(started.map(s => s.id))).size === 0) break
			await sleep(3_000)
		}
		if (stop.requested) {
			seconds = Math.max(1, Math.min(seconds, Math.round((Date.now() - loadStarted) / 1_000)))
			caveats.push(`the run was stopped after about ${seconds}s, before its bees finished`)
		}

		for (const { bee, id } of started) {
			const found = beeLinesIn(await docker.logs(id).catch(() => ''))
			if (found.length === 0) caveats.push(`${bee.id} wrote nothing a bee writes`)
			lines = lines.concat(found)
		}
	} finally {
		teardown = await tearDown(
			plan,
			docker,
			started.map(s => s.id),
		)
		await launcher.cleanup().catch(() => undefined)
	}
	return { host: plan.host.name, startedAt, lines, teardown, caveats, seconds }
}

/**
 * Runs one plan per host at once, as one run; if any host fails, the others are stopped and every host still tears down.
 */
export const conductAcross = async (
	runs: readonly HostRun[],
	say: Progress,
	stop: { requested: boolean } = { requested: false },
): Promise<RunRecord> => {
	const first = runs[0]
	if (first === undefined) throw new Error('a run needs at least one host')
	say(`running for ${first.plan.shape.seconds}s of load`)
	const settled = await Promise.allSettled(
		runs.map(run =>
			conductHost(run, say, stop).catch((error: unknown) => {
				stop.requested = true
				throw error
			}),
		),
	)
	const failure = settled.find(outcome => outcome.status === 'rejected')
	if (failure !== undefined) throw failure.reason
	const outcomes = settled.flatMap(outcome =>
		outcome.status === 'fulfilled' ? [outcome.value] : [],
	)

	const seconds = Math.min(...outcomes.map(outcome => outcome.seconds))
	const result = reconcile(
		outcomes.flatMap(outcome => outcome.lines),
		seconds,
	)
	const several = outcomes.length > 1
	const caveats = outcomes.flatMap(outcome =>
		outcome.caveats.map(caveat => (several ? `${outcome.host}: ${caveat}` : caveat)),
	)
	for (const kind of ['browser', 'protocol'] as const) {
		const outcome = result[kind]
		// A request still waiting at the deadline is not counted, so a store the bees cannot reach reads as zero, not as failures.
		if (outcome !== undefined && outcome.count === 0) {
			caveats.push(
				`no ${kind} request completed: the bees ran but may not reach the store at ${first.plan.url}`,
			)
		}
		if (outcome !== undefined && outcome.finished < outcome.bees) {
			caveats.push(
				`${outcome.bees - outcome.finished} ${kind} bee(s) did not finish cleanly, so their last window may be missing`,
			)
		}
	}
	const unknown = outcomes.some(outcome => outcome.teardown.leftover < 0)
	const host = outcomes.map(outcome => outcome.host).join('+')
	return {
		drexbot: RECORD_TAG,
		run: first.plan.run,
		startedAt: outcomes.map(outcome => outcome.startedAt).sort()[0] ?? new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		target: first.plan.url,
		host,
		via: first.plan.via,
		shape: first.plan.shape,
		shapeKey: shapeKey(first.plan.shape, host, first.plan.via),
		result,
		teardown: {
			removed: outcomes.reduce((sum, outcome) => sum + outcome.teardown.removed, 0),
			leftover: unknown
				? -1
				: outcomes.reduce((sum, outcome) => sum + outcome.teardown.leftover, 0),
			verified: outcomes.every(outcome => outcome.teardown.verified),
		},
		caveats,
	}
}

export const conduct = async (
	plan: RunPlan,
	docker: Docker,
	launcher: Launcher,
	say: Progress,
	stop: { requested: boolean } = { requested: false },
): Promise<RunRecord> => conductAcross([{ plan, docker, launcher }], say, stop)

/** Removes every container of the run, by what was started and by label, then looks again. */
export const tearDown = async (
	plan: Pick<RunPlan, 'run'>,
	docker: Docker,
	ids: readonly string[],
): Promise<Teardown> => {
	const labelled = await docker.list(`${RUN_LABEL}=${plan.run}`).catch(() => [])
	const all = [...new Set([...ids, ...labelled.map(c => c.id)])]
	await docker.remove(all).catch(() => undefined)
	const left = await docker.list(`${RUN_LABEL}=${plan.run}`).catch(() => undefined)
	const byId = left === undefined ? undefined : await stillThere(docker, ids)
	if (left === undefined || byId === undefined) {
		return { removed: all.length, leftover: -1, verified: false }
	}
	const leftover = new Set([...left.map(c => c.id), ...byId]).size
	return { removed: all.length - leftover, leftover, verified: leftover === 0 }
}

const stillThere = async (
	docker: Docker,
	ids: readonly string[],
): Promise<string[] | undefined> => {
	try {
		const found: string[] = []
		for (const id of ids) {
			const exists = await docker
				.docker(['container', 'inspect', '--format', '{{.Id}}', id])
				.then(() => true)
				.catch((error: Error) => {
					if (/no such (container|object)/i.test(error.message)) return false
					throw error
				})
			if (exists) found.push(id)
		}
		return found
	} catch {
		return undefined
	}
}
