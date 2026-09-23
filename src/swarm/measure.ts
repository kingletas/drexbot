import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from 'harness-kernel'
import { catalogueFor, loadStore } from '../magento/baseline.js'
import { conduct, dockerLauncher } from './conductor.js'
import { Docker, RUN_LABEL } from './docker.js'
import { planRun, runId, stagesOf, type Shape } from './plan.js'
import { recordsDirectory } from './record.js'
import { allowedTargets, bytesOf, hostNamed, refusalFor } from './settings.js'

/**
 * How much load one bee of a given size drives, measured against a warmed caching proxy so the store is never the bottleneck.
 * Concurrency rises step by step until throughput stops following it; the step before that is what the bee sustains.
 */

const STANDIN_CPUS = 2
const STANDIN_MEMORY = bytesOf('512m')

/** Adding concurrency that buys less than this much more throughput means the bee is full. */
const STILL_SCALING = 1.15

export interface Step {
	readonly concurrency: number
	readonly perSecond: number
	readonly failures: number
	readonly ttfbP95: number | undefined
	readonly totalP95: number | undefined
	/** Why a step says nothing, when it says nothing. */
	readonly note?: string
}

/** The last step whose throughput still rose by STILL_SCALING over the one before it. */
export const saturation = (steps: readonly Step[]): Step | undefined => {
	let sustained: Step | undefined = steps[0]
	for (let i = 1; i < steps.length; i++) {
		const before = steps[i - 1]
		const now = steps[i]
		if (before === undefined || now === undefined) break
		if (now.failures > 0 || now.perSecond < before.perSecond * STILL_SCALING) break
		sustained = now
	}
	return sustained
}

const standInConfig = (upstream: string): string => `
proxy_cache_path /var/cache/drexbot levels=1:2 keys_zone=store:64m max_size=900m inactive=1d use_temp_path=off;
server {
	listen 80;
	location / {
		proxy_pass http://${upstream};
		proxy_http_version 1.1;
		proxy_set_header Host $http_host;
		proxy_set_header Connection "";
		# Magento's cache-tag headers outgrow nginx's default 4k header buffer.
		proxy_buffer_size 64k;
		proxy_buffers 16 64k;
		proxy_busy_buffers_size 128k;
		proxy_cache store;
		proxy_cache_key $request_method$request_uri;
		proxy_cache_valid 200 301 302 404 1d;
		proxy_ignore_headers Cache-Control Expires Set-Cookie Vary X-Accel-Expires;
		proxy_hide_header Set-Cookie;
		proxy_cache_lock on;
		add_header X-Drexbot-Stand-In $upstream_cache_status always;
	}
}
`

const flag = (argv: readonly string[], name: string): string | undefined => {
	const index = argv.indexOf(name)
	return index === -1 ? undefined : argv[index + 1]
}

export const measure = async (
	harness: Harness,
	argv: readonly string[],
	images: { readonly browser: string; readonly protocol: string },
	say: (message: string) => void,
): Promise<number> => {
	const kind = flag(argv, '--kind')
	const url = flag(argv, '--url') ?? process.env['MAGENTO_URL']
	const upstream = flag(argv, '--upstream')
	const upstreamNetwork = flag(argv, '--upstream-network')
	if ((kind !== 'browser' && kind !== 'protocol') || url === undefined || upstream === undefined) {
		process.stderr.write(
			'usage: drexbot swarm measure --kind browser|protocol --url URL --upstream HOST:PORT\n' +
				'         [--on HOST] [--env NAME] [--steps 1,2,4,6] [--cpus N] [--memory SIZE] [--seconds N]\n' +
				'         [--upstream-network NAME]\n' +
				'  --upstream is where the store answers as seen from the bee host, for the warm-up.\n' +
				'  --upstream-network joins the stand-in to a Docker network the store is on, so a store\n' +
				'  running on the bee host is reached container to container, with no port opened.\n',
		)
		return 2
	}
	const refusal = refusalFor(url, allowedTargets())
	if (refusal !== undefined) throw new Error(refusal)
	if (new URL(url).protocol !== 'http:') {
		throw new Error('measure proxies the store over plain HTTP, so it needs an http:// store URL')
	}
	const environment = flag(argv, '--env') ?? 'local'
	const store = catalogueFor(
		loadStore(join(harness.workspace.baselines, `magento--${environment}.store.json`)),
		url,
		environment,
	)
	if (!store.captured) throw new Error(store.uncapturedBecause ?? 'no store baseline')

	const host = hostNamed(flag(argv, '--on') ?? 'local')
	const cpus = Number(flag(argv, '--cpus') ?? (kind === 'browser' ? '2' : '1'))
	const memory = bytesOf(flag(argv, '--memory') ?? (kind === 'browser' ? '2g' : '1g'))
	const seconds = Number(flag(argv, '--seconds') ?? '30')
	const steps = (
		flag(argv, '--steps') ?? (kind === 'browser' ? '1,2,3,4,6,8' : '25,50,100,200,400,800')
	)
		.split(',')
		.map(Number)
	// The stand-in takes its share of the budget first, so the bee is measured with room around it.
	const room = { ...host, cpus: host.cpus - STANDIN_CPUS, memory: host.memory - STANDIN_MEMORY }
	const docker = new Docker(host)
	const id = `measure-${runId()}`
	const network = `drexbot-${id}`
	const port = new URL(url).port || '80'
	const forward = `${port}=standin:80`

	const shapeFor = (bee: 'browser' | 'protocol', concurrency: number, length: number): Shape => ({
		browser: { bees: bee === 'browser' ? 1 : 0, workers: concurrency, cpus, memory },
		protocol: { bees: bee === 'protocol' ? 1 : 0, users: concurrency, cpus, memory },
		seconds: length,
	})
	const step = async (bee: 'browser' | 'protocol', concurrency: number, length: number) => {
		const plan = planRun({
			url: store.baseUrl,
			stages: stagesOf(store),
			host: room,
			via: 'docker',
			shape: shapeFor(bee, concurrency, length),
			images,
			forward,
			run: `${id}-${bee}${concurrency}`,
		})
		if (typeof plan === 'string') throw new Error(plan)
		return conduct(plan, docker, dockerLauncher(docker, network), () => undefined)
	}

	const results: Step[] = []
	await docker.docker(['network', 'create', '--label', `${RUN_LABEL}=${id}`, network])
	try {
		// Created, joined to every network, then started: nginx resolves its upstream once, at start.
		const standIn = `drexbot-${id}-standin`
		await docker.docker([
			'create',
			'--name',
			standIn,
			'--network',
			network,
			'--network-alias',
			'standin',
			'--label',
			`${RUN_LABEL}=${id}`,
			'--cpus',
			String(STANDIN_CPUS),
			'--memory',
			String(STANDIN_MEMORY),
			'--tmpfs',
			'/var/cache/drexbot:rw,mode=1777,size=1g',
			'--env',
			`STANDIN_CONF=${standInConfig(upstream)}`,
			'--add-host',
			'host.docker.internal:host-gateway',
			'nginx:1.30',
			'sh',
			'-c',
			'printf "%s" "$STANDIN_CONF" > /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"',
		])
		if (upstreamNetwork !== undefined) {
			await docker.docker(['network', 'connect', upstreamNetwork, standIn])
		}
		await docker.docker(['start', standIn])
		if ((await docker.running([standIn])).size === 0) {
			throw new Error(
				`the stand-in stopped as it started: ${(await docker.logs(standIn)).trim().slice(-300)}`,
			)
		}
		say(`stand-in up on ${host.name}; warming its cache from ${upstream} with one browser bee`)
		const warm = await step('browser', 2, 40)
		const loaded = warm.result.combined.count - warm.result.combined.failures
		if (loaded === 0)
			throw new Error('the warm-up loaded no page from the store; is --upstream right?')
		for (const concurrency of steps) {
			const record = await step(kind, concurrency, seconds)
			const outcome = record.result[kind]
			const row: Step = {
				concurrency,
				perSecond: outcome?.perSecond ?? 0,
				failures: outcome?.failures ?? 0,
				ttfbP95: outcome?.ttfb.p95,
				totalP95: Object.values(outcome?.stages ?? {})
					.map(stage => stage.total.p95 ?? 0)
					.reduce((max, value) => Math.max(max, value), 0),
			}
			if (outcome === undefined || outcome.count === 0) {
				results.push({ ...row, note: record.caveats.join('; ') || 'the bee completed no request' })
				break
			}
			results.push(row)
			say(
				`${kind} x${concurrency}: ${row.perSecond}/s, ${row.failures} failed, ttfb p95 ${row.ttfbP95 ?? '-'} ms` +
					(record.teardown.verified ? '' : ', TEARDOWN NOT VERIFIED'),
			)
			if (row.failures > 0) break
		}
	} finally {
		const left = await docker.list(`${RUN_LABEL}=${id}`)
		await docker.remove(left.map(c => c.id))
		await docker.docker(['network', 'rm', network]).catch(() => undefined)
	}

	const sustained = saturation(results)
	const summary = {
		drexbot: 'swarm-measure/1',
		id,
		host: host.name,
		kind,
		size: { cpus, memory },
		seconds,
		store: store.baseUrl,
		steps: results,
		sustained: sustained ?? null,
	}
	const directory = join(recordsDirectory(harness.workspace.results), 'measure')
	mkdirSync(directory, { recursive: true })
	writeFileSync(
		join(directory, `${id}-${host.name}-${kind}.json`),
		`${JSON.stringify(summary, null, '\t')}\n`,
	)
	process.stdout.write(
		`\n  ${kind} bee, ${cpus} CPU and ${Math.round(memory / 1024 ** 2)} MiB, on ${host.name}:\n` +
			results
				.map(
					r =>
						`    ${String(r.concurrency).padStart(4)}  ${String(r.perSecond).padStart(8)}/s  ttfb p95 ${r.ttfbP95 ?? '-'} ms` +
						(kind === 'browser' ? `  load p95 ${r.totalP95 ?? '-'} ms` : '') +
						(r.failures > 0 ? `  ${r.failures} failed` : '') +
						(r.note === undefined ? '' : `  (${r.note})`),
				)
				.join('\n') +
			`\n  sustained: ${sustained === undefined ? 'nothing' : `${sustained.concurrency} ${kind === 'browser' ? 'workers' : 'users'} at ${sustained.perSecond}/s`}\n\n`,
	)
	return 0
}
