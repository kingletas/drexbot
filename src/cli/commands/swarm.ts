import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness, Options } from 'harness-kernel'
import { catalogueFor, loadStore } from '../../magento/baseline.js'
import { beeLinesIn } from '../../bee/lines.js'
import { awsHandover } from '../../swarm/aws.js'
import { conduct, dockerLauncher, ecsLauncher } from '../../swarm/conductor.js'
import { Docker, RUN_LABEL } from '../../swarm/docker.js'
import { ECS_CLUSTER_LABEL, CLUSTER, emulatorRefusal } from '../../swarm/ecs.js'
import { measure } from '../../swarm/measure.js'
import {
	planRun,
	shapeKey,
	stagesOf,
	type RunPlan,
	type Shape,
	type Via,
} from '../../swarm/plan.js'
import { reconcile } from '../../swarm/reconcile.js'
import {
	previousFor,
	readRecords,
	recordsDirectory,
	renderRecord,
	writeRecord,
	RECORD_TAG,
	type RunRecord,
} from '../../swarm/record.js'
import { allowedTargets, bytesOf, hostNamed, refusalFor } from '../../swarm/settings.js'

/**
 * `drexbot swarm`: load from bees in containers, blended from browsers and
 * plain HTTP, against a store the operator has said is theirs, with every run
 * recorded and every container's removal checked.
 */

export const SWARM_USAGE = `usage: drexbot swarm COMMAND [flags]

  run       start bees against a store, wait, tear down, and record the run
  aws       print the same run as AWS commands for a person to run; runs nothing
  reconcile DIR   turn the bee lines downloaded after an AWS run into a record
  images    build both bee images on a bee host
  sweep     remove every bee container on a bee host, from any run
  records   list recorded runs
  measure   how much load one bee of a given size can drive

Flags for run and aws:
  --url URL               the store; must be in swarm-targets        (default: $MAGENTO_URL)
  --env NAME              whose store baseline to read               (default: local)
  --on HOST               a bee host from swarm-hosts, or local      (default: local)
  --via docker|ecs        start bees with Docker, or as ECS tasks on the local
                          emulator named by DREXBOT_ECS_ENDPOINT     (default: docker)
  --seconds N             seconds of load                            (default: 60)
  --browser-bees N        --browser-workers N  --browser-cpus N  --browser-memory SIZE
                          (defaults 1, 2, 2, 2g: one CPU starves Chromium on a real store)
  --protocol-bees N       --protocol-users N   --protocol-cpus N  --protocol-memory SIZE
                          (defaults 1, 50, 1, 1g: 512m ran out at 400 users)
  --forward PORT=HOST:PORT   relay inside each bee, for a store only reachable by
                          another address than its own URL
`

const flag = (argv: readonly string[], name: string): string | undefined => {
	const index = argv.indexOf(name)
	return index === -1 ? undefined : argv[index + 1]
}

const number = (argv: readonly string[], name: string, fallback: number): number => {
	const raw = flag(argv, name)
	if (raw === undefined) return fallback
	const value = Number(raw)
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} needs a number, not "${raw}"`)
	return value
}

const version = (harness: Harness): string =>
	(
		JSON.parse(readFileSync(join(harness.workspace.root, 'package.json'), 'utf8')) as {
			version: string
		}
	).version

const images = (harness: Harness) => ({
	browser: `drexbot-bee-browser:${version(harness)}`,
	protocol: `drexbot-bee-protocol:${version(harness)}`,
})

const say = (message: string): void => {
	process.stderr.write(`  ${message}\n`)
}

const shapeFrom = (argv: readonly string[]): Shape => ({
	browser: {
		bees: number(argv, '--browser-bees', 1),
		workers: number(argv, '--browser-workers', 2),
		cpus: number(argv, '--browser-cpus', 2),
		memory: bytesOf(flag(argv, '--browser-memory') ?? '2g'),
	},
	protocol: {
		bees: number(argv, '--protocol-bees', 1),
		users: number(argv, '--protocol-users', 50),
		cpus: number(argv, '--protocol-cpus', 1),
		memory: bytesOf(flag(argv, '--protocol-memory') ?? '1g'),
	},
	seconds: number(argv, '--seconds', 60),
})

/** Everything that can refuse a run, checked before anything starts. */
const planFrom = (
	harness: Harness,
	options: Options,
	argv: readonly string[],
): RunPlan | string => {
	const url = options.url ?? process.env['MAGENTO_URL']
	if (url === undefined) return 'name the store with --url, or set MAGENTO_URL'
	const refusal = refusalFor(url, allowedTargets())
	if (refusal !== undefined) return refusal
	const environment = options.environment ?? 'local'
	const store = catalogueFor(
		loadStore(join(harness.workspace.baselines, `magento--${environment}.store.json`)),
		url,
		environment,
	)
	if (!store.captured) return store.uncapturedBecause ?? 'no store baseline'
	const via = (flag(argv, '--via') ?? 'docker') as Via
	if (via !== 'docker' && via !== 'ecs') return `--via is docker or ecs, not "${String(via)}"`
	const forward = flag(argv, '--forward')
	return planRun({
		url: store.baseUrl,
		stages: stagesOf(store),
		host: hostNamed(flag(argv, '--on') ?? 'local'),
		via,
		shape: shapeFrom(argv),
		images: images(harness),
		...(forward === undefined ? {} : { forward }),
	})
}

const run = async (
	harness: Harness,
	options: Options,
	argv: readonly string[],
): Promise<number> => {
	const plan = planFrom(harness, options, argv)
	if (typeof plan === 'string') {
		process.stderr.write(`drexbot swarm: ${plan}\n`)
		return 2
	}
	const docker = new Docker(plan.host)
	for (const image of new Set(plan.bees.map(bee => bee.image))) {
		if (!(await docker.hasImage(image))) {
			process.stderr.write(
				`drexbot swarm: ${plan.host.name} has no ${image}; build it with: drexbot swarm images --on ${plan.host.name}\n`,
			)
			return 2
		}
	}
	let launcher
	if (plan.via === 'ecs') {
		const endpoint = process.env['DREXBOT_ECS_ENDPOINT']
		const refusal = emulatorRefusal(endpoint)
		if (refusal !== undefined || endpoint === undefined) {
			process.stderr.write(`drexbot swarm: ${refusal ?? 'no endpoint'}\n`)
			return 2
		}
		launcher = ecsLauncher(endpoint, docker)
	} else {
		launcher = dockerLauncher(docker)
	}

	const stop = { requested: false }
	const onSignal = (): void => {
		if (stop.requested) process.exit(130)
		stop.requested = true
		say('stopping: tearing the bees down (Ctrl-C again to leave them to stop at their own limit)')
	}
	process.on('SIGINT', onSignal)
	say(
		`run ${plan.run}: ${plan.bees.length} bee(s) on ${plan.host.name} via ${plan.via}, against ${plan.url}`,
	)
	try {
		const record = await conduct(plan, docker, launcher, say, stop)
		const records = readRecords(harness.workspace.results)
		const path = writeRecord(harness.workspace.results, record)
		process.stdout.write(renderRecord(record, previousFor(record, records)))
		process.stdout.write(`  recorded in ${path.replace(harness.workspace.root, '.')}\n\n`)
		return record.teardown.verified && record.result.combined.count > 0 ? 0 : 1
	} finally {
		process.off('SIGINT', onSignal)
	}
}

const sweep = async (argv: readonly string[]): Promise<number> => {
	const host = hostNamed(flag(argv, '--on') ?? 'local')
	const docker = new Docker(host)
	// An emulator's task containers carry its cluster label, whose account and region vary; the name does not.
	const ours = [
		...(await docker.list(RUN_LABEL)),
		...(await docker.list(ECS_CLUSTER_LABEL)).filter(c =>
			(c.labels[ECS_CLUSTER_LABEL] ?? '').endsWith(`/${CLUSTER}`),
		),
	]
	const ids = [...new Set(ours.map(c => c.id))]
	await docker.remove(ids)
	const left = (await docker.list(RUN_LABEL)).length
	process.stdout.write(`  ${host.name}: removed ${ids.length} bee container(s); ${left} left\n`)
	return left === 0 ? 0 : 1
}

const buildImages = async (harness: Harness, argv: readonly string[]): Promise<number> => {
	const host = hostNamed(flag(argv, '--on') ?? 'local')
	if (!existsSync(join(harness.workspace.root, 'dist', 'src', 'bee', 'browser.js'))) {
		process.stderr.write('drexbot swarm: the bee is not compiled; run make build first\n')
		return 2
	}
	const docker = new Docker(host)
	for (const [kind, image] of Object.entries(images(harness))) {
		say(`building ${image} on ${host.name}`)
		await docker.docker([
			'build',
			'--quiet',
			'--file',
			join(harness.workspace.root, 'bees', kind, 'Dockerfile'),
			'--tag',
			image,
			harness.workspace.root,
		])
	}
	say('both bee images built')
	return 0
}

const aws = (harness: Harness, options: Options, argv: readonly string[]): number => {
	const plan = planFrom(harness, options, [...argv, '--via', 'ecs'])
	if (typeof plan === 'string') {
		process.stderr.write(`drexbot swarm: ${plan}\n`)
		return 2
	}
	const directory = join(recordsDirectory(harness.workspace.results), 'aws', plan.run)
	process.stdout.write(awsHandover(plan, directory))
	return 0
}

/** A record from an AWS run: the bees' lines as downloaded, with teardown left to the person who ran it. */
const reconcileDirectory = (harness: Harness, directory: string | undefined): number => {
	if (directory === undefined || !existsSync(join(directory, 'plan.json'))) {
		process.stderr.write('usage: drexbot swarm reconcile DIR   (the directory `swarm aws` wrote)\n')
		return 2
	}
	const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as RunPlan
	const lines = beeLinesIn(readFileSync(join(directory, 'bee-lines.txt'), 'utf8'))
	const record: RunRecord = {
		drexbot: RECORD_TAG,
		run: plan.run,
		startedAt: lines[0]?.at ?? new Date().toISOString(),
		finishedAt: lines.at(-1)?.at ?? new Date().toISOString(),
		target: plan.url,
		host: 'aws',
		via: 'ecs' as const,
		shape: plan.shape,
		shapeKey: shapeKey(plan.shape, 'aws', 'ecs'),
		result: reconcile(lines, plan.shape.seconds),
		teardown: { removed: 0, leftover: -1, verified: false },
		caveats: [
			'teardown on AWS is checked by the person who ran the commands, with the list-tasks block',
		],
	}
	const records = readRecords(harness.workspace.results)
	writeRecord(harness.workspace.results, record)
	process.stdout.write(renderRecord(record, previousFor(record, records)))
	return 0
}

const listRecords = (harness: Harness): number => {
	for (const record of readRecords(harness.workspace.results)) {
		const c = record.result.combined
		process.stdout.write(
			`  ${record.run}  ${record.target}  ${record.shapeKey}  ${c.count} requests, ttfb p95 ${c.ttfb.p95 ?? '-'} ms` +
				`${record.teardown.verified ? '' : '  (teardown not verified)'}\n`,
		)
	}
	return 0
}

export const swarmCommand = async (
	harness: Harness,
	options: Options,
	argv: readonly string[],
): Promise<number> => {
	const [sub, ...rest] = argv
	try {
		switch (sub) {
			case 'run':
				return await run(harness, options, rest)
			case 'aws':
				return aws(harness, options, rest)
			case 'reconcile':
				return reconcileDirectory(harness, rest[0])
			case 'images':
				return await buildImages(harness, rest)
			case 'sweep':
				return await sweep(rest)
			case 'records':
				return listRecords(harness)
			case 'measure':
				return await measure(harness, rest, images(harness), say)
			default:
				process.stderr.write(SWARM_USAGE)
				return 2
		}
	} catch (cause) {
		process.stderr.write(
			`drexbot swarm: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		)
		return 1
	}
}
