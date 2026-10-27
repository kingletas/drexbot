import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness, Options } from 'harness-kernel'
import { catalogueFor, loadStore } from '../../magento/baseline.js'
import { beeLinesIn } from '../../bee/lines.js'
import { awsHandover } from '../../swarm/aws.js'
import {
	conductAcross,
	dockerLauncher,
	ecsLauncher,
	type HostRun,
	type Launcher,
} from '../../swarm/conductor.js'
import { dayReport, renderDay, writeDay } from '../../swarm/day.js'
import { deployReport, readLedger } from '../../swarm/deploys.js'
import {
	besideKnee,
	fractionOf,
	kneeRecordOf,
	latestKnee,
	missingKnee,
	shareOf,
	spread,
	usersAt,
	writeKnee,
	type KneeShare,
} from '../../swarm/knee.js'
import { Docker, RUN_LABEL } from '../../swarm/docker.js'
import { ECS_CLUSTER_LABEL, CLUSTER, emulatorRefusal } from '../../swarm/ecs.js'
import { measure } from '../../swarm/measure.js'
import { ordersFrom, parseInterval } from '../../swarm/orders.js'
import {
	planRun,
	runId,
	shapeKey,
	stagesOf,
	type RunPlan,
	type Shape,
	type Via,
} from '../../swarm/plan.js'
import { reconcile } from '../../swarm/reconcile.js'
import { shopRun } from '../../swarm/shop.js'
import { timelineOf } from '../../swarm/timeline.js'
import { isMixName, MIXES, type MixName } from '../../bee/mix.js'
import {
	checkoutP95Of,
	ordersOf,
	previousFor,
	readRecords,
	recordsDirectory,
	renderRecord,
	writeBeeLines,
	writeRecord,
	RECORD_TAG,
	type RunRecord,
} from '../../swarm/record.js'
import { allowedTargets, bytesOf, hostNamed, localHost, refusalFor } from '../../swarm/settings.js'
import {
	judge,
	MACHINE_BUSY,
	nextStep,
	renderStepTest,
	type StepOutcome,
	type StepTaken,
} from '../../swarm/step.js'
import { againstCaps, capsRefusal, machineLoad, sampleStore } from '../../swarm/store-load.js'

/**
 * `drexbot swarm`: load from bees in containers, blended from browsers and
 * plain HTTP, against a store the operator has said is theirs, with every run
 * recorded and every container's removal checked.
 */

export const SWARM_USAGE = `usage: drexbot swarm COMMAND [flags]

  run       start bees against a store, wait, tear down, and record the run
  aws       print the same run as AWS commands for a person to run; runs nothing
  reconcile DIR [--deploy-ledger FILE]
            turn the bee lines downloaded after an AWS run into a record
  images    build both bee images on a bee host
  sweep     remove every bee container on a bee host, from any run
  records   list recorded runs
  measure   how much load one bee of a given size can drive
  step      raise protocol users step by step until the store reaches its knee
  shop      one run at the rate the time of day calls for, for a timer to start
  day       DATE --deploy-ledger FILE
            place the day's runs before, during or after its deploys

Flags for run and aws:
  --url URL               the store; must be in swarm-targets        (default: $MAGENTO_URL)
  --env NAME              whose store baseline to read               (default: local)
  --on HOST[,HOST]        bee hosts from swarm-hosts, or local; each runs the whole
                          shape, and the run is recorded as one  (default: local)
  --via docker|ecs        start bees with Docker, or as ECS tasks on the local
                          emulator named by DREXBOT_ECS_ENDPOINT     (default: docker)
  --seconds N             seconds of load                            (default: 60)
  --browser-bees N        --browser-workers N  --browser-cpus N  --browser-memory SIZE
                          (defaults 1, 2, 2, 2g: one CPU starves Chromium on a real store)
  --protocol-bees N       --protocol-users N   --protocol-cpus N  --protocol-memory SIZE
                          (defaults 1, 50, 1, 1g: 512m ran out at 400 users)
  --forward PORT=HOST:PORT   relay inside each bee, for a store only reachable by
                          another address than its own URL
  --network NAME          with --via docker: start the bees on a Docker network the
                          store is on, so a store on the bee host is reached
                          container to container, with no port opened
  --mix NAME              what the bees' shoppers do: browse, normal-day or
                          checkout-stress; the last two place orders and need
                          MAGENTO_DISPOSABLE=1                       (default: browse)
  --orders N --per DURATION
                          place N orders in every DURATION (60s, 5m, 1h; at least
                          10s), evenly, from one protocol bee and no browser bees;
                          needs MAGENTO_DISPOSABLE=1 and a SKU; not with --mix or
                          --protocol-users
  --sku SKU               the simple product protocol bees add to carts over REST
                          (default: the one in the store baseline)
  --store-cpus N          the CPUs the store is capped at, so orders read per core
  --cgroup-parent SLICE   create every bee under this systemd slice, such as lab.slice
                          (default: $DREXBOT_CGROUP_PARENT, else Docker's own)
  --of-knee F             run only: protocol users at F (above 0, at most 1) of the
                          last good step of the newest knee swarm step measured
                          for this store; sets the bees itself, browser bees none
  --knee-mix NAME         the mix that knee was measured at          (default: normal-day)
  --deploy-ledger FILE    run and reconcile only: a deploy tool's audit log (JSONL);
                          the deploys that fall within the run are recorded, with
                          their maintenance window

Flags for step, beside those for run (it sets the bee counts itself):
  --store-project NAME    the store's Compose project on this machine, whose
                          services are sampled against their CPU caps (required)
  --start N               users in the first step                    (default: 10)
  --most N                the test gives up without a knee past this (default: 640)
  --resolution F          the knee's bracket is narrow enough at this share
                          of the last good step                      (default: 0.1)
  --users-per-bee N       protocol users one bee drives at most      (default: 100)
  --fpm-workers N         PHP-FPM's max_children, so orders read per worker

Flags for shop, beside those for run (it sets --orders, --per and --seconds itself):
  --night HH:MM-HH:MM     the local-time window that holds the daily deploy; it may
                          cross midnight                             (required)
  --night-orders N        orders in each slice inside the window     (default: 25)
  --day-orders N          orders in each slice outside it            (default: 5)
  --per DURATION          the slice, such as 5m: the timer's interval (default: 5m)
  --seconds N             the slice's load; a slice's orders are paced over it, and
                          60 seconds are left to start and remove the bee before
                          the next tick                    (default: the slice less 60)

Flags for day: --url URL reports one store, otherwise every store is reported;
  --deploy-ledger FILE is the deploy tool's audit log                (required);
  --around DURATION is how far before and after each deploy its bands reach (default: 2h)
`

const flag = (argv: readonly string[], name: string): string | undefined => {
	const index = argv.indexOf(name)
	return index === -1 ? undefined : argv[index + 1]
}

/** The deploy ledger a run was told to read, or undefined when it was told none. */
const ledgerFlag = (argv: readonly string[]): string | undefined => {
	if (!argv.includes('--deploy-ledger')) return undefined
	const file = flag(argv, '--deploy-ledger')
	if (file === undefined || file.startsWith('--')) throw new Error('--deploy-ledger needs a file')
	return file
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

const shapeFrom = (argv: readonly string[], orders: Shape['orders']): Shape => ({
	browser: {
		// A rate places its orders from a protocol bee alone.
		bees: number(argv, '--browser-bees', orders === undefined ? 1 : 0),
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
	...(flag(argv, '--mix') === undefined ? {} : { mix: flag(argv, '--mix') as MixName }),
	...(orders === undefined ? {} : { orders }),
})

/** Everything that can refuse one host's part of a run, checked before anything starts. */
const planFrom = (
	harness: Harness,
	options: Options,
	argv: readonly string[],
	hostName: string,
	run?: string,
	beePrefix?: string,
): RunPlan | string => {
	const orders = ordersFrom(argv)
	if (typeof orders === 'string') return orders
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
	const mix = flag(argv, '--mix')
	if (mix !== undefined && !isMixName(mix)) {
		return `--mix is one of ${Object.keys(MIXES).join(', ')}, not "${mix}"`
	}
	const storeCpus =
		flag(argv, '--store-cpus') === undefined ? undefined : number(argv, '--store-cpus', 0)
	// The flag, or the timer's environment; an empty variable is one nobody set.
	const cgroupParent = argv.includes('--cgroup-parent')
		? (flag(argv, '--cgroup-parent') ?? '')
		: process.env['DREXBOT_CGROUP_PARENT'] || undefined
	const cartPath = store.simpleProductPath ?? store.configurableProductPath
	const cartSku = flag(argv, '--sku') ?? store.simpleProductSku
	const via = (flag(argv, '--via') ?? 'docker') as Via
	if (via !== 'docker' && via !== 'ecs') return `--via is docker or ecs, not "${String(via)}"`
	const host = hostNamed(hostName)
	// A flag names the route for this run; otherwise the host's own line in swarm-hosts does.
	const forward = flag(argv, '--forward') ?? host.forward
	return planRun({
		url: store.baseUrl,
		stages: stagesOf(store),
		host,
		via,
		shape: shapeFrom(argv, orders),
		images: images(harness),
		...(forward === undefined ? {} : { forward }),
		...(run === undefined ? {} : { run }),
		...(beePrefix === undefined ? {} : { beePrefix }),
		...(cartPath === undefined ? {} : { cartPath }),
		...(cartSku === undefined ? {} : { cartSku }),
		disposable: process.env['MAGENTO_DISPOSABLE'] === '1',
		...(storeCpus === undefined || storeCpus === 0 ? {} : { storeCpus }),
		...(cgroupParent === undefined
			? {}
			: {
					cgroupParent,
					cgroupParentFrom: argv.includes('--cgroup-parent')
						? ('--cgroup-parent' as const)
						: ('DREXBOT_CGROUP_PARENT' as const),
				}),
	})
}

/**
 * A run's flags with its users set from the knee: `--of-knee` of the last good
 * step of the newest knee measured for this store, on protocol bees only, as
 * the knee was measured. Or why it cannot be set, before anything starts.
 */
const kneeArgv = (
	harness: Harness,
	options: Options,
	argv: readonly string[],
): { argv: string[]; share: KneeShare; users: number } | string => {
	const beside = besideKnee(argv)
	if (beside !== undefined) return beside
	const fraction = fractionOf(flag(argv, '--of-knee'))
	if (typeof fraction === 'string') return fraction
	if (number(argv, '--browser-bees', 0) > 0)
		return '--of-knee sets protocol users only, as the knee was measured; drop --browser-bees'
	const probe = planFrom(harness, options, [...argv, '--browser-bees', '0'], 'local')
	if (typeof probe === 'string') return probe
	const kneeMix = flag(argv, '--knee-mix') ?? 'normal-day'
	const knee = latestKnee(harness.workspace.results, probe.url, kneeMix)
	if (knee === undefined) return missingKnee(probe.url, kneeMix)
	const users = usersAt(knee, fraction)
	if (typeof users === 'string') return users
	const { bees, each } = spread(users, number(argv, '--users-per-bee', 100))
	return {
		argv: [
			...withoutFlags(argv, ['--browser-bees', '--of-knee', '--knee-mix']),
			'--browser-bees',
			'0',
			'--protocol-bees',
			String(bees),
			'--protocol-users',
			String(each),
		],
		share: shareOf(knee, fraction),
		users: bees * each,
	}
}

const run = async (
	harness: Harness,
	options: Options,
	given: readonly string[],
): Promise<number> => {
	let argv: readonly string[] = given
	let knee: KneeShare | undefined
	if (given.includes('--of-knee')) {
		const set = kneeArgv(harness, options, given)
		if (typeof set === 'string') {
			process.stderr.write(`drexbot swarm: ${set}\n`)
			return 2
		}
		argv = set.argv
		knee = set.share
		say(
			`${knee.fraction} of the knee: ${knee.lastGood} users at its last good step, so ${set.users} users`,
		)
	}
	const hosts = (flag(argv, '--on') ?? 'local').split(',').filter(name => name !== '')
	if (flag(argv, '--via') === 'ecs' && hosts.length > 1) {
		process.stderr.write(
			'drexbot swarm: --via ecs runs on one host, the one its emulator starts containers on\n',
		)
		return 2
	}
	// Refuse a ledger that is unreadable or malformed now, rather than after the load has run.
	let ledger: string | undefined
	try {
		ledger = ledgerFlag(argv)
		if (ledger !== undefined) readLedger(ledger)
	} catch (cause) {
		process.stderr.write(
			`drexbot swarm: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		)
		return 2
	}
	const id = runId()
	const runs: HostRun[] = []
	for (const name of hosts) {
		const plan = planFrom(harness, options, argv, name, id, hosts.length > 1 ? name : undefined)
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
		let launcher: Launcher
		if (plan.via === 'ecs') {
			const endpoint = process.env['DREXBOT_ECS_ENDPOINT']
			const refusal = emulatorRefusal(endpoint)
			if (refusal !== undefined || endpoint === undefined) {
				process.stderr.write(`drexbot swarm: ${refusal ?? 'no endpoint'}\n`)
				return 2
			}
			launcher = ecsLauncher(endpoint, docker)
		} else {
			launcher = dockerLauncher(docker, flag(argv, '--network') ?? plan.host.network)
		}
		runs.push({ plan, docker, launcher })
	}

	const stop = { requested: false }
	const onSignal = (): void => {
		if (stop.requested) process.exit(130)
		stop.requested = true
		say('stopping: tearing the bees down (Ctrl-C again to leave them to stop at their own limit)')
	}
	process.on('SIGINT', onSignal)
	const bees = runs.reduce((sum, part) => sum + part.plan.bees.length, 0)
	say(`run ${id}: ${bees} bee(s) on ${hosts.join(' and ')}, against ${runs[0]?.plan.url ?? ''}`)
	try {
		const conducted = await conductAcross(runs, say, stop, ledger)
		const record: RunRecord = knee === undefined ? conducted.record : { ...conducted.record, knee }
		const records = readRecords(harness.workspace.results)
		const path = writeRecord(harness.workspace.results, record)
		writeBeeLines(harness.workspace.results, record.run, conducted.lines)
		process.stdout.write(renderRecord(record, previousFor(record, records)))
		process.stdout.write(`  recorded in ${path.replace(harness.workspace.root, '.')}\n\n`)
		return record.teardown.verified &&
			record.result.combined.count > 0 &&
			record.deploys?.refused === undefined
			? 0
			: 1
	} finally {
		process.off('SIGINT', onSignal)
	}
}

/** One run at the rate the clock calls for, through the same path as `swarm run`. */
const shop = async (
	harness: Harness,
	options: Options,
	argv: readonly string[],
): Promise<number> => {
	const slice = shopRun(argv, new Date())
	if (typeof slice === 'string') {
		process.stderr.write(`drexbot swarm: ${slice}\n`)
		return 2
	}
	say(`shop: ${slice.night ? 'night' : 'day'} rate, ${slice.orders} orders per ${slice.per}`)
	return run(harness, options, slice.argv)
}

/** The day's runs placed against its deploys, printed and written beside the run records. */
const day = (harness: Harness, options: Options, argv: readonly string[]): number => {
	const date = argv[0]
	let report: ReturnType<typeof dayReport>
	try {
		const ledger = ledgerFlag(argv)
		if (date === undefined || date.startsWith('--') || ledger === undefined) {
			process.stderr.write('usage: drexbot swarm day DATE --deploy-ledger FILE [--url URL]\n')
			return 2
		}
		const aroundText = flag(argv, '--around') ?? '2h'
		const around = parseInterval(aroundText)
		if (around === undefined) {
			process.stderr.write(
				`drexbot swarm: --around is a duration such as 30m or 2h, not "${aroundText}"\n`,
			)
			return 2
		}
		report = dayReport(
			date,
			readRecords(harness.workspace.results),
			readLedger(ledger),
			ledger,
			options.url ?? flag(argv, '--url'),
			around,
		)
	} catch (cause) {
		process.stderr.write(
			`drexbot swarm: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		)
		return 2
	}
	if (typeof report === 'string') {
		process.stderr.write(`drexbot swarm: ${report}\n`)
		return 2
	}
	process.stdout.write(renderDay(report))
	if (report.stores.length === 0) return 1
	const path = writeDay(harness.workspace.results, report)
	process.stdout.write(`  recorded in ${path.replace(harness.workspace.root, '.')}\n\n`)
	return 0
}

const withoutFlags = (argv: readonly string[], names: readonly string[]): string[] => {
	const out: string[] = []
	for (let i = 0; i < argv.length; i++) {
		if (names.includes(argv[i] ?? '')) i++
		else out.push(argv[i] ?? '')
	}
	return out
}

/**
 * The step test: one run per step, each with protocol bees only, the store's
 * services sampled against their caps while it runs. It stops at the knee, at a
 * break, or when a bad step came while the machine itself was busy, because
 * then the knee may be the machine's.
 */
const stepTest = async (
	harness: Harness,
	options: Options,
	argv: readonly string[],
): Promise<number> => {
	const project = flag(argv, '--store-project')
	if (project === undefined) {
		process.stderr.write(
			"drexbot swarm: step needs --store-project, the store's Compose project on this machine\n",
		)
		return 2
	}
	const plan = {
		start: number(argv, '--start', 10),
		most: number(argv, '--most', 640),
		resolution: number(argv, '--resolution', 0.1),
	}
	const perBee = Math.max(1, number(argv, '--users-per-bee', 100))
	const workers =
		flag(argv, '--fpm-workers') === undefined ? undefined : number(argv, '--fpm-workers', 0)
	const base = withoutFlags(argv, ['--browser-bees', '--protocol-bees', '--protocol-users', '--on'])
	// The knee is read at the normal day's mix unless the operator asks for another.
	if (flag(base, '--mix') === undefined) base.push('--mix', 'normal-day')
	const storeDocker = new Docker(localHost())
	// The knee is read as ratios against the store's caps, so a store without any is refused before a step runs.
	let uncapped: string | undefined
	try {
		uncapped = await capsRefusal(storeDocker, project)
	} catch (cause) {
		uncapped = cause instanceof Error ? cause.message : String(cause)
	}
	if (uncapped !== undefined) {
		process.stderr.write(`drexbot swarm: ${uncapped}\n`)
		return 2
	}
	const steps: StepTaken[] = []
	const testId = runId()
	let target = ''
	// A knee is kept only when the steps ended on the store's own limit, not on the machine's, a hand or a teardown.
	let kept = true
	let done = ''
	const stop = { requested: false }
	const onSignal = (): void => {
		if (stop.requested) process.exit(130)
		stop.requested = true
		say('stopping: this step tears down and no other starts')
	}
	process.on('SIGINT', onSignal)
	try {
		for (;;) {
			const next = nextStep(steps, plan)
			if ('done' in next) {
				done = next.done
				break
			}
			if (stop.requested) {
				done = 'stopped by hand'
				kept = false
				break
			}
			const bees = Math.ceil(next.users / perBee)
			const each = Math.ceil(next.users / bees)
			const users = bees * each
			const stepArgv = [
				...base,
				'--browser-bees',
				'0',
				'--protocol-bees',
				String(bees),
				'--protocol-users',
				String(each),
			]
			const runPlan = planFrom(harness, options, stepArgv, 'local', runId())
			if (typeof runPlan === 'string') {
				process.stderr.write(`drexbot swarm: ${runPlan}\n`)
				return 2
			}
			target = runPlan.url
			const docker = new Docker(runPlan.host)
			for (const image of new Set(runPlan.bees.map(bee => bee.image))) {
				if (!(await docker.hasImage(image))) {
					process.stderr.write(
						`drexbot swarm: local has no ${image}; build it with: drexbot swarm images --on local\n`,
					)
					return 2
				}
			}
			const launcher = dockerLauncher(docker, flag(argv, '--network') ?? runPlan.host.network)
			say(`step ${steps.length + 1}: ${users} users on ${bees} protocol bee(s)`)
			const sampler = await sampleStore(storeDocker, project)
			const { record, lines } = await conductAcross(
				[{ plan: runPlan, docker, launcher }],
				say,
				stop,
			)
			const load = await sampler.stop()
			writeRecord(harness.workspace.results, record)
			writeBeeLines(harness.workspace.results, record.run, lines)
			const outcome: StepOutcome = {
				users,
				checkoutP95: checkoutP95Of(record),
				p95: record.result.combined.ttfb.p95,
				requests: record.result.combined.count,
				failures: record.result.combined.failures,
				perSecond: Math.round((record.result.combined.count / record.shape.seconds) * 10) / 10,
			}
			const judged = judge(steps, outcome)
			const taken: StepTaken = {
				...judged,
				run: record.run,
				seconds: record.shape.seconds,
				ordersPlaced: ordersOf(record),
				capped: againstCaps(load),
				machineLoad: machineLoad(load),
			}
			steps.push(taken)
			say(`  ${taken.verdict}: ${taken.reason}`)
			if (!record.teardown.verified) {
				done = `stopped: step ${steps.length}'s teardown was not verified, so no other step starts`
				kept = false
				break
			}
			if (taken.verdict !== 'good' && taken.machineLoad >= MACHINE_BUSY) {
				done = `stopped at ${users} users: the step went bad while the machine was at ${Math.round(taken.machineLoad * 100)}% load, so it may be the machine's knee, not the store's`
				kept = false
				break
			}
		}
	} finally {
		process.off('SIGINT', onSignal)
	}
	process.stdout.write(
		renderStepTest(steps, done, {
			target: steps.length === 0 ? '' : (options.url ?? process.env['MAGENTO_URL'] ?? ''),
			mix: flag(base, '--mix') ?? 'normal-day',
			...(workers === undefined || workers === 0 ? {} : { workers }),
		}),
	)
	const knee = kneeRecordOf(steps, done, {
		id: testId,
		target,
		mix: flag(base, '--mix') ?? 'normal-day',
	})
	if (kept && knee?.firstBad !== undefined) {
		const path = writeKnee(harness.workspace.results, knee)
		process.stdout.write(
			`  knee recorded in ${path.replace(harness.workspace.root, '.')}; swarm run --of-knee F reads it\n\n`,
		)
	} else {
		process.stdout.write("  no knee recorded: the steps did not end on the store's own limit\n\n")
	}
	return steps.length > 0 ? 0 : 1
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
	const plan = planFrom(harness, options, [...argv, '--via', 'ecs'], flag(argv, '--on') ?? 'local')
	if (typeof plan === 'string') {
		process.stderr.write(`drexbot swarm: ${plan}\n`)
		return 2
	}
	const directory = join(recordsDirectory(harness.workspace.results), 'aws', plan.run)
	process.stdout.write(awsHandover(plan, directory))
	return 0
}

/** A record from an AWS run: the bees' lines as downloaded, with teardown left to the person who ran it. */
const reconcileDirectory = (harness: Harness, argv: readonly string[]): number => {
	const directory = argv[0]
	if (directory === undefined || !existsSync(join(directory, 'plan.json'))) {
		process.stderr.write(
			'usage: drexbot swarm reconcile DIR [--deploy-ledger FILE]   (DIR is the directory `swarm aws` wrote)\n',
		)
		return 2
	}
	const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as RunPlan
	const lines = beeLinesIn(readFileSync(join(directory, 'bee-lines.txt'), 'utf8'))
	const ledger = ledgerFlag(argv)
	const startedAt = lines[0]?.at ?? new Date().toISOString()
	const finishedAt = lines.at(-1)?.at ?? new Date().toISOString()
	const timeline = timelineOf(lines)
	const record: RunRecord = {
		drexbot: RECORD_TAG,
		run: plan.run,
		startedAt,
		finishedAt,
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
		...(ledger === undefined
			? {}
			: { deploys: deployReport(ledger, { startedAt, finishedAt }, lines) }),
		...(timeline === undefined ? {} : { timeline }),
	}
	const records = readRecords(harness.workspace.results)
	writeRecord(harness.workspace.results, record)
	process.stdout.write(renderRecord(record, previousFor(record, records)))
	return record.deploys?.refused === undefined ? 0 : 1
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
				return reconcileDirectory(harness, rest)
			case 'images':
				return await buildImages(harness, rest)
			case 'sweep':
				return await sweep(rest)
			case 'records':
				return listRecords(harness)
			case 'measure':
				return await measure(harness, rest, images(harness), say)
			case 'step':
				return await stepTest(harness, options, rest)
			case 'shop':
				return await shop(harness, options, rest)
			case 'day':
				return day(harness, options, rest)
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
