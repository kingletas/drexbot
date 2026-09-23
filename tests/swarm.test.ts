import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
	BUCKETS,
	FIRST_BOUND_MS,
	GROWTH,
	bucketOf,
	countOf,
	merge,
	percentile,
	record,
	type Histogram,
} from '../src/bee/histogram.js'
import { beeLinesIn, Windows, type BeeLine } from '../src/bee/lines.js'
import { readBeeConfig } from '../src/bee/config.js'
import { awsHandover } from '../src/swarm/aws.js'
import { conduct, conductAcross, tearDown, type Launcher } from '../src/swarm/conductor.js'
import type { Container, Docker } from '../src/swarm/docker.js'
import { emulatorRefusal, EcsEmulator } from '../src/swarm/ecs.js'
import { saturation } from '../src/swarm/measure.js'
import { planRun, shapeKey, stagesOf, type RunPlan, type Shape } from '../src/swarm/plan.js'
import { reconcile } from '../src/swarm/reconcile.js'
import { previousFor, renderRecord, RECORD_TAG, type RunRecord } from '../src/swarm/record.js'
import {
	allowedTargets,
	beeHosts,
	bytesOf,
	refusalFor,
	type BeeHost,
} from '../src/swarm/settings.js'
import type { StoreBaseline } from '../src/magento/baseline.js'

const ROOT = join(import.meta.dirname, '..', '..')

const host: BeeHost = {
	name: 'bees',
	dockerHost: 'ssh://bees.example',
	cpus: 4,
	memory: bytesOf('8g'),
}

const shape = (overrides: Partial<Shape> = {}): Shape => ({
	browser: { bees: 1, workers: 2, cpus: 1, memory: bytesOf('1536m') },
	protocol: { bees: 1, users: 50, cpus: 1, memory: bytesOf('512m') },
	seconds: 60,
	...overrides,
})

/** A plan's refusal, or an empty string when it planned: the refusal is what these tests read. */
const refusalOf = (planned: RunPlan | string): string =>
	typeof planned === 'string' ? planned : ''

const plan = (overrides: Partial<Shape> = {}): RunPlan => {
	const planned = planRun({
		url: 'http://store.example:8080/',
		stages: [
			{ stage: 'home', path: '/' },
			{ stage: 'category', path: '/gear.html' },
		],
		host,
		via: 'docker',
		shape: shape(overrides),
		images: { browser: 'bee-browser:test', protocol: 'bee-protocol:test' },
		run: 'run-1',
	})
	assert.equal(typeof planned, 'object')
	return planned as RunPlan
}

describe('the latency histogram', () => {
	it('puts a value in the first bucket whose upper bound holds it', () => {
		assert.equal(bucketOf(0), 0)
		assert.equal(bucketOf(1), 0)
		assert.equal(bucketOf(1.2), 1)
		assert.equal(bucketOf(1.25), 1)
		assert.equal(bucketOf(1.26), 2)
		assert.equal(bucketOf(Number.NaN), 0)
		assert.equal(bucketOf(10 ** 9), BUCKETS - 1)
	})

	it('reports a percentile no lower than the truth and at most a quarter over it', () => {
		const histogram: Histogram = {}
		for (let ms = 1; ms <= 1000; ms++) record(histogram, ms)
		const p95 = percentile(histogram, 0.95)
		assert.ok(p95 !== undefined && p95 >= 950 && p95 <= 950 * GROWTH, `p95 was ${p95}`)
		assert.equal(percentile({}, 0.5), undefined)
	})

	it('adds two histograms into exactly the histogram of both samples', () => {
		const a: Histogram = {}
		const b: Histogram = {}
		const both: Histogram = {}
		for (const ms of [3, 40, 400]) {
			record(a, ms)
			record(both, ms)
		}
		for (const ms of [5, 40, 4000]) {
			record(b, ms)
			record(both, ms)
		}
		assert.deepEqual(merge({ ...a }, b), both)
		assert.equal(countOf(both), 6)
	})

	it('uses the same buckets inside the k6 protocol bee', () => {
		const script = readFileSync(join(ROOT, 'bees', 'protocol', 'bee.js'), 'utf8')
		assert.match(script, new RegExp(`const FIRST_BOUND_MS = ${FIRST_BOUND_MS}\\n`))
		assert.match(script, new RegExp(`const GROWTH = ${GROWTH}\\n`))
		assert.match(script, new RegExp(`const BUCKETS = ${BUCKETS}\\n`))
	})
})

describe('what a bee writes', () => {
	it('empties its tallies on every flush, so windows add rather than overlap', () => {
		const windows = new Windows({ run: 'r', bee: 'b', kind: 'browser' })
		windows.add({ stage: 'home', status: 200, ttfbMs: 12, totalMs: 300, lcpMs: 250 })
		windows.add({ stage: 'home', status: 503, ttfbMs: 40 })
		windows.add({ stage: 'home', status: undefined })
		const [first] = windows.flush()
		assert.equal(first?.count, 3)
		assert.equal(first?.failures, 2)
		assert.deepEqual(first?.statuses, { '200': 1, '503': 1, error: 1 })
		assert.deepEqual(windows.flush(), [])
	})

	it('finds its lines among whatever else shares the stream', () => {
		const line = JSON.stringify({
			drexbot: 'bee/1',
			event: 'finished',
			run: 'r',
			bee: 'b',
			kind: 'protocol',
			at: 'now',
			concurrency: 1,
		})
		const found = beeLinesIn(`noise\n${line}\n2026 prefix ${line}\n{"drexbot":"bee/1", broken\n`)
		assert.equal(found.length, 2)
	})

	it('names the variable a bee is missing', () => {
		assert.throws(() => readBeeConfig({}), /BEE_PATHS is not set/)
		const env = {
			BEE_PATHS: '[{"stage":"home","path":"/"}]',
			BEE_RUN: 'r',
			BEE_ID: 'b',
			BEE_URL: 'http://localhost:8080/',
			BEE_CONCURRENCY: '0',
			BEE_SECONDS: '30',
		}
		assert.throws(() => readBeeConfig(env), /BEE_CONCURRENCY must be a positive number/)
		assert.equal(readBeeConfig({ ...env, BEE_CONCURRENCY: '3' }).concurrency, 3)
		assert.throws(() => readBeeConfig({ ...env, BEE_PATHS: '[]' }), /non-empty/)
	})
})

describe('which stores and machines a swarm may use', () => {
	const directory = mkdtempSync(join(tmpdir(), 'swarm-settings-'))
	writeFileSync(
		join(directory, 'swarm-targets'),
		'# stores that are ours\nhttp://store.example:8080/some/path\nnot a url\n',
	)
	writeFileSync(join(directory, 'swarm-hosts'), 'bees ssh://bees.example cpus=4 memory=8g\n')

	it('refuses a store nobody listed, and names the file to list it in', () => {
		const allowed = allowedTargets(directory)
		assert.deepEqual(allowed, ['http://store.example:8080'])
		assert.equal(refusalFor('http://store.example:8080/gear.html', allowed), undefined)
		assert.match(refusalFor('http://store.example:8081/', allowed) ?? '', /not in swarm-targets/)
		assert.match(refusalFor('https://store.example:8080/', allowed) ?? '', /not in swarm-targets/)
		assert.match(refusalFor('http://other.example/', []) ?? '', /swarm-targets/)
	})

	it('refuses everything when no list exists', () => {
		assert.deepEqual(allowedTargets(mkdtempSync(join(tmpdir(), 'swarm-empty-'))), [])
	})

	it('reads a machine with its budget, and refuses one without', () => {
		assert.deepEqual(beeHosts(directory), [
			{ name: 'bees', dockerHost: 'ssh://bees.example', cpus: 4, memory: 8 * 1024 ** 3 },
		])
		const bad = mkdtempSync(join(tmpdir(), 'swarm-bad-'))
		writeFileSync(join(bad, 'swarm-hosts'), 'bees ssh://bees.example cpus=4\n')
		assert.throws(() => beeHosts(bad), /needs NAME DOCKER_HOST cpus=N memory=SIZE/)
		assert.throws(() => bytesOf('lots'), /not a size/)
	})
})

describe('planning a run', () => {
	it('refuses bees that do not fit the machine, before anything starts', () => {
		const refused = planRun({
			url: 'http://store.example:8080/',
			stages: [{ stage: 'home', path: '/' }],
			host,
			via: 'docker',
			shape: shape({ browser: { bees: 4, workers: 2, cpus: 1, memory: bytesOf('1536m') } }),
			images: { browser: 'b', protocol: 'p' },
		})
		assert.match(refusalOf(refused), /need 5 CPUs .* allows 4 CPUs/)
	})

	it('refuses a run with no bees or too short to say anything', () => {
		const base = {
			url: 'http://s/',
			stages: [],
			host,
			via: 'docker' as const,
			images: { browser: 'b', protocol: 'p' },
		}
		assert.match(
			refusalOf(
				planRun({
					...base,
					shape: shape({
						browser: { bees: 0, workers: 1, cpus: 1, memory: 1 },
						protocol: { bees: 0, users: 1, cpus: 1, memory: 1 },
					}),
				}),
			),
			/at least one bee/,
		)
		assert.match(
			refusalOf(planRun({ ...base, shape: shape({ seconds: 5 }) })),
			/at least 10 seconds/,
		)
	})

	it('gives every bee its orders, a lifetime past its load, and its own id', () => {
		const planned = plan()
		assert.deepEqual(
			planned.bees.map(bee => [bee.id, bee.kind, bee.concurrency]),
			[
				['browser-1', 'browser', 2],
				['protocol-1', 'protocol', 50],
			],
		)
		const env = planned.bees[1]?.env ?? {}
		assert.equal(env['BEE_ID'], 'protocol-1')
		assert.equal(env['BEE_SECONDS'], '60')
		assert.ok(Number(env['BEE_LIFETIME']) > 60)
		assert.equal((JSON.parse(env['BEE_PATHS'] ?? '[]') as unknown[]).length, 2)
	})

	it('walks the pages the store baseline names, leaving out what it lacks', () => {
		const store = {
			categoryPath: '/gear.html',
			searchTerm: 'bag',
			simpleProductPath: '/bag.html',
		} as StoreBaseline
		assert.deepEqual(
			stagesOf(store).map(s => s.stage),
			['home', 'category', 'search', 'product'],
		)
		assert.deepEqual(
			stagesOf({ ...store, searchTerm: '', simpleProductPath: undefined }).map(s => s.stage),
			['home', 'category'],
		)
	})
})

const window = (
	kind: 'browser' | 'protocol',
	bee: string,
	stage: string,
	ms: number[],
	failures = 0,
): BeeLine => {
	const ttfb: Histogram = {}
	for (const value of ms) record(ttfb, value)
	return {
		drexbot: 'bee/1',
		event: 'window',
		run: 'r',
		bee,
		kind,
		at: '2026-01-01T00:00:00.000Z',
		stage,
		count: ms.length,
		failures,
		statuses: { '200': ms.length - failures, ...(failures > 0 ? { '503': failures } : {}) },
		ttfb,
		total: ttfb,
	}
}

const finished = (kind: 'browser' | 'protocol', bee: string): BeeLine => ({
	drexbot: 'bee/1',
	event: 'finished',
	run: 'r',
	bee,
	kind,
	at: '2026-01-01T00:01:00.000Z',
	concurrency: 1,
})

describe('reconciling two kinds of bee into one result', () => {
	it('adds every bee of a kind, and both kinds for what the store did', () => {
		const result = reconcile(
			[
				window('browser', 'browser-1', 'home', [100, 110]),
				window('protocol', 'protocol-1', 'home', [20, 20, 20], 1),
				window('protocol', 'protocol-2', 'home', [30]),
				finished('browser', 'browser-1'),
				finished('protocol', 'protocol-1'),
			],
			10,
		)
		assert.equal(result.browser?.count, 2)
		assert.equal(result.protocol?.count, 4)
		assert.equal(result.protocol?.bees, 2)
		assert.equal(result.protocol?.finished, 1)
		assert.equal(result.protocol?.perSecond, 0.4)
		assert.equal(result.combined.count, 6)
		assert.equal(result.combined.failures, 1)
		assert.equal(result.combined.errorRate, 0.1667)
		assert.ok((result.combined.ttfb.p99 ?? 0) >= 110)
	})

	it('leaves out a kind that did not run', () => {
		const result = reconcile([window('protocol', 'protocol-1', 'home', [5])], 10)
		assert.equal(result.browser, undefined)
		assert.equal(result.combined.count, 1)
	})
})

const recordOf = (
	run: string,
	startedAt: string,
	overrides: Partial<RunRecord> = {},
): RunRecord => ({
	drexbot: RECORD_TAG,
	run,
	startedAt,
	finishedAt: startedAt,
	target: 'http://store.example:8080/',
	host: 'bees',
	via: 'docker',
	shape: shape(),
	shapeKey: shapeKey(shape(), 'bees', 'docker'),
	result: reconcile([window('protocol', 'p', 'home', [20])], 60),
	teardown: { removed: 2, leftover: 0, verified: true },
	caveats: [],
	...overrides,
})

describe('the run record', () => {
	it('compares only with an earlier run of the same shape against the same store', () => {
		const now = recordOf('c', '2026-01-03')
		const records = [
			recordOf('a', '2026-01-01'),
			recordOf('b', '2026-01-02'),
			recordOf('other-store', '2026-01-02T12', { target: 'http://elsewhere/' }),
			recordOf('other-shape', '2026-01-02T13', { shapeKey: 'different' }),
			recordOf('later', '2026-01-04'),
		]
		assert.equal(previousFor(now, records)?.run, 'b')
		assert.equal(previousFor(recordOf('first', '2025-12-31'), records), undefined)
	})

	it('says loudly when teardown was not verified', () => {
		const text = renderRecord(
			recordOf('x', '2026-01-01', { teardown: { removed: 1, leftover: 1, verified: false } }),
		)
		assert.match(text, /TEARDOWN NOT VERIFIED: 1 container/)
		assert.match(
			renderRecord(recordOf('y', '2026-01-01')),
			/teardown verified: 2 bee container\(s\) removed, none left/,
		)
	})
})

describe('the ECS path only ever reaches an emulator', () => {
	it('refuses AWS and anything else that is not this machine', () => {
		for (const endpoint of [
			undefined,
			'',
			'https://ecs.us-east-1.amazonaws.com',
			'http://ecs.us-east-1.amazonaws.com',
			'https://127.0.0.1:4566',
			'http://203.0.113.20:4566',
			'not a url',
		]) {
			assert.notEqual(emulatorRefusal(endpoint), undefined, String(endpoint))
		}
		for (const endpoint of [
			'http://127.0.0.1:14566',
			'http://localhost:4566',
			'http://172.17.0.1:4566',
		]) {
			assert.equal(emulatorRefusal(endpoint), undefined, endpoint)
		}
	})

	it('refuses in its constructor, before a single request could be made', () => {
		const original = globalThis.fetch
		let called = false
		globalThis.fetch = () => {
			called = true
			throw new Error('fetch must not be called')
		}
		try {
			assert.throws(
				() => new EcsEmulator('https://ecs.us-east-1.amazonaws.com', {} as Docker),
				/not a local emulator/,
			)
			assert.equal(called, false)
		} finally {
			globalThis.fetch = original
		}
	})
})

describe('the AWS hand-over', () => {
	it('prints one command per block, each saying what it creates or destroys, and runs nothing', () => {
		const directory = mkdtempSync(join(tmpdir(), 'swarm-aws-'))
		const text = awsHandover(plan(), directory)
		const blocks = text.split('```bash\n').slice(1)
		assert.ok(blocks.length >= 8)
		for (const block of blocks) {
			const command = block.slice(0, block.indexOf('\n```'))
			assert.equal(command.split('\n').length, 1, `one command per block: ${command}`)
		}
		for (const comment of text.split('\n').filter(line => line.startsWith('# '))) {
			assert.match(comment, /Creates|Destroys|Uploads|Starts|Stops|Registers/, comment)
		}
		assert.match(text, /run-task --cluster drexbot-swarm/)
		assert.match(text, /list-tasks --cluster drexbot-swarm --started-by run-1/)
		assert.deepEqual(readdirSync(directory).sort(), [
			'browser-1.task-definition.json',
			'plan.json',
			'protocol-1.task-definition.json',
		])
	})
})

describe('measuring how much one bee can drive', () => {
	const step = (concurrency: number, perSecond: number, failures = 0) => ({
		concurrency,
		perSecond,
		failures,
		ttfbP95: 10,
		totalP95: 100,
	})

	it('stops at the last step that still bought more throughput', () => {
		assert.equal(saturation([step(1, 10), step(2, 19), step(4, 36), step(6, 38)])?.concurrency, 4)
		assert.equal(saturation([step(1, 10), step(2, 10.5)])?.concurrency, 1)
		assert.equal(saturation([step(1, 10), step(2, 20, 3)])?.concurrency, 1)
		assert.equal(saturation([]), undefined)
	})
})

/** A Docker that keeps its containers in memory, and can be told to keep one it was asked to remove. */
class FakeDocker {
	readonly containers = new Map<
		string,
		{ labels: Record<string, string>; running: boolean; logs: string }
	>()
	stubborn = new Set<string>()
	private next = 0

	readonly host = host
	async start(run: string, bee: { id: string; kind: 'browser' | 'protocol' }): Promise<string> {
		const id = `c${++this.next}`
		const line = JSON.stringify({
			drexbot: 'bee/1',
			event: 'finished',
			run,
			bee: bee.id,
			kind: bee.kind,
			at: 'now',
			concurrency: 1,
		})
		this.containers.set(id, {
			labels: { 'drexbot.swarm.run': run },
			running: false,
			logs: `${line}\n`,
		})
		return id
	}
	async running(ids: readonly string[]): Promise<Set<string>> {
		return new Set(ids.filter(id => this.containers.get(id)?.running))
	}
	async logs(id: string): Promise<string> {
		return this.containers.get(id)?.logs ?? ''
	}
	async list(label: string): Promise<Container[]> {
		const [key, value] = label.split('=')
		return [...this.containers.entries()]
			.filter(
				([, c]) =>
					key !== undefined && (value === undefined ? key in c.labels : c.labels[key] === value),
			)
			.map(([id, c]) => ({ id, name: id, running: c.running, labels: c.labels }))
	}
	async remove(ids: readonly string[]): Promise<void> {
		for (const id of ids) if (!this.stubborn.has(id)) this.containers.delete(id)
	}
	async docker(args: readonly string[]): Promise<string> {
		const id = args.at(-1) ?? ''
		if (this.containers.has(id)) return id
		throw new Error(`Error: No such container: ${id}`)
	}
}

describe('conducting a run', () => {
	it('removes every bee and verifies nothing is left', async () => {
		const docker = new FakeDocker()
		const launcher: Launcher = {
			start: (run, bee) => docker.start(run, bee),
			cleanup: () => Promise.resolve(),
		}
		const record = await conduct(plan(), docker as unknown as Docker, launcher, () => undefined)
		assert.equal(docker.containers.size, 0)
		assert.deepEqual(record.teardown, { removed: 2, leftover: 0, verified: true })
	})

	it('still tears down what started when a later bee fails to start', async () => {
		const docker = new FakeDocker()
		let starts = 0
		const launcher: Launcher = {
			start: async (run, bee) => {
				if (++starts === 2) throw new Error('no such image')
				return docker.start(run, bee)
			},
			cleanup: () => Promise.resolve(),
		}
		await assert.rejects(
			conduct(plan(), docker as unknown as Docker, launcher, () => undefined),
			/no such image/,
		)
		assert.equal(docker.containers.size, 0)
	})

	it('reports a container that would not go as unverified, never as removed', async () => {
		const docker = new FakeDocker()
		const id = await docker.start('run-1', { id: 'browser-1', kind: 'browser' })
		docker.stubborn.add(id)
		const teardown = await tearDown({ run: 'run-1' }, docker as unknown as Docker, [id])
		assert.equal(teardown.verified, false)
		assert.equal(teardown.leftover, 1)
	})
})

describe('one run across several hosts', () => {
	const across = (overrides: { prefix: string; name: string }) => {
		const planned = planRun({
			url: 'http://store.example:8080/',
			stages: [{ stage: 'home', path: '/' }],
			host: { ...host, name: overrides.name },
			via: 'docker',
			shape: shape(),
			images: { browser: 'b', protocol: 'p' },
			run: 'run-2',
			beePrefix: overrides.prefix,
		})
		assert.equal(typeof planned, 'object')
		return planned as RunPlan
	}

	it('gives every bee on every host its own id', () => {
		assert.deepEqual(
			across({ prefix: 'bees', name: 'bees' }).bees.map(bee => bee.id),
			['bees-browser-1', 'bees-protocol-1'],
		)
	})

	it('records both hosts as one run, and verifies teardown on each', async () => {
		const here = new FakeDocker()
		const there = new FakeDocker()
		const launcherFor = (docker: FakeDocker): Launcher => ({
			start: (run, bee) => docker.start(run, bee),
			cleanup: () => Promise.resolve(),
		})
		const record = await conductAcross(
			[
				{
					plan: across({ prefix: 'here', name: 'here' }),
					docker: here as unknown as Docker,
					launcher: launcherFor(here),
				},
				{
					plan: across({ prefix: 'there', name: 'there' }),
					docker: there as unknown as Docker,
					launcher: launcherFor(there),
				},
			],
			() => undefined,
		)
		assert.equal(record.host, 'here+there')
		assert.equal(record.result.browser?.bees, 2)
		assert.deepEqual(record.teardown, { removed: 4, leftover: 0, verified: true })
		assert.equal(here.containers.size + there.containers.size, 0)
	})

	it('stops the other hosts and still tears every one down when one fails', async () => {
		const here = new FakeDocker()
		const there = new FakeDocker()
		const stop = { requested: false }
		await assert.rejects(
			conductAcross(
				[
					{
						plan: across({ prefix: 'here', name: 'here' }),
						docker: here as unknown as Docker,
						launcher: {
							start: (run, bee) => here.start(run, bee),
							cleanup: () => Promise.resolve(),
						},
					},
					{
						plan: across({ prefix: 'there', name: 'there' }),
						docker: there as unknown as Docker,
						launcher: {
							start: () => Promise.reject(new Error('there has no image')),
							cleanup: () => Promise.resolve(),
						},
					},
				],
				() => undefined,
				stop,
			),
			/there has no image/,
		)
		assert.equal(stop.requested, true)
		assert.equal(here.containers.size + there.containers.size, 0)
	})
})

describe('a host line that names its own route to the store', () => {
	it('reads a relay and a network, and lets local be overridden', () => {
		const directory = mkdtempSync(join(tmpdir(), 'swarm-routes-'))
		writeFileSync(
			join(directory, 'swarm-hosts'),
			'local - cpus=2 memory=4g network=store_default forward=8080=web:80\nbees ssh://bees.example cpus=4 memory=8g forward=8080=198.51.100.7:18080\n',
		)
		const [local, bees] = beeHosts(directory)
		assert.equal(local?.dockerHost, undefined)
		assert.equal(local?.network, 'store_default')
		assert.equal(local?.forward, '8080=web:80')
		assert.equal(bees?.forward, '8080=198.51.100.7:18080')
		assert.equal(bees?.network, undefined)
	})
})
