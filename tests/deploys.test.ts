import assert from 'node:assert/strict'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Harness, Options } from 'harness-kernel'
import { record, type Histogram } from '../src/bee/histogram.js'
import { LINE_TAG, type BeeLine } from '../src/bee/lines.js'
import { swarmCommand } from '../src/cli/commands/swarm.js'
import {
	DEPLOY_MARGIN_SECONDS,
	deployReport,
	deployWindows,
	parseLedger,
	readLedger,
	renderDeploys,
} from '../src/swarm/deploys.js'
import { reconcile } from '../src/swarm/reconcile.js'
import { RECORD_TAG, renderRecord, type RunRecord } from '../src/swarm/record.js'
import { bytesOf } from '../src/swarm/settings.js'
import { shapeKey, type Shape } from '../src/swarm/plan.js'

/** An invented ledger: made-up releases on a made-up environment, in the shape the deploy tool writes. */
const entry = (
	time: string,
	event: string,
	release: string,
	extra: Record<string, unknown> = {},
): string =>
	JSON.stringify({
		actor: { control_host: 'ops.example.com', git_email: 'alex@example.com', os_user: 'alex' },
		env_name: 'showcase',
		event,
		recorded_at: time,
		release,
		schema: 1,
		...extra,
	})

const INSIDE = '20261101_1000000001_showcase'
const NEVER_CLOSED = '20261101_1000000002_showcase'
const EARLIER = '20261101_0900000003_showcase'
const LATER = '20261101_1300000004_showcase'
const JUST_BEFORE = '20261101_1200000005_showcase'

/** The run: 12:00:00 to 12:03:00 on an invented day. */
const RUN = { startedAt: '2026-11-01T12:00:00.000Z', finishedAt: '2026-11-01T12:03:00.000Z' }

const LEDGER = [
	// Hours before the run: not in it.
	entry('2026-11-01T09:00:00Z', 'deploy.started', EARLIER),
	entry('2026-11-01T09:02:00Z', 'deploy.finished', EARLIER, { outcome: 'success' }),
	// Ended 30 seconds before the run began, so inside the margin.
	entry('2026-11-01T11:58:40Z', 'deploy.started', JUST_BEFORE),
	entry('2026-11-01T11:59:30Z', 'deploy.finished', JUST_BEFORE, { outcome: 'success' }),
	// Inside the run, with a maintenance window that closed.
	entry('2026-11-01T12:00:50Z', 'deploy.started', INSIDE),
	entry('2026-11-01T12:00:52Z', 'build.started', INSIDE),
	entry('2026-11-01T12:01:05Z', 'build.succeeded', INSIDE),
	entry('2026-11-01T12:01:06Z', 'upload.started', INSIDE),
	entry('2026-11-01T12:01:09Z', 'upload.succeeded', INSIDE),
	entry('2026-11-01T12:01:09Z', 'cutover.started', INSIDE),
	entry('2026-11-01T12:01:10Z', 'maintenance.enabled', INSIDE),
	entry('2026-11-01T12:01:12Z', 'upgrade.started', INSIDE),
	entry('2026-11-01T12:01:25Z', 'upgrade.succeeded', INSIDE),
	entry('2026-11-01T12:01:30Z', 'maintenance.disabled', INSIDE),
	entry('2026-11-01T12:01:40Z', 'cutover.succeeded', INSIDE),
	entry('2026-11-01T12:01:50Z', 'deploy.finished', INSIDE, { outcome: 'success' }),
	// Inside the run, failing in setup:upgrade and leaving the window open.
	entry('2026-11-01T12:02:20Z', 'deploy.started', NEVER_CLOSED),
	entry('2026-11-01T12:02:35Z', 'maintenance.enabled', NEVER_CLOSED),
	entry('2026-11-01T12:02:40Z', 'upgrade.started', NEVER_CLOSED),
	entry('2026-11-01T12:02:50Z', 'upgrade.failed', NEVER_CLOSED),
	entry('2026-11-01T12:02:55Z', 'deploy.failed', NEVER_CLOSED, { phase: 'after-switch' }),
	// Long after the run.
	entry('2026-11-01T13:00:00Z', 'deploy.started', LATER),
	entry('2026-11-01T13:01:00Z', 'deploy.finished', LATER, { outcome: 'success' }),
].join('\n')

const at = (second: number): string =>
	new Date(Date.parse(RUN.startedAt) + second * 1_000).toISOString()

/** A browser bee's windows every ten seconds, with the store failing for the ones given. */
const browserLines = (failing: readonly number[]): BeeLine[] => {
	const identity = {
		drexbot: LINE_TAG as typeof LINE_TAG,
		run: 'r',
		bee: 'browser-1',
		kind: 'browser' as const,
	}
	const lines: BeeLine[] = [{ ...identity, event: 'started', at: at(0), concurrency: 2 }]
	for (let end = 10; end <= 180; end += 10) {
		const down = failing.includes(end)
		const ttfb: Histogram = {}
		for (let i = 0; i < 10; i += 1) record(ttfb, down ? 3_000 : 100)
		lines.push({
			...identity,
			event: 'window',
			at: at(end),
			stage: 'home',
			count: 10,
			failures: down ? 10 : 0,
			statuses: down ? { '503': 10 } : { '200': 10 },
			ttfb,
			total: ttfb,
		})
	}
	return lines
}

const protocolLine = (): BeeLine => ({
	drexbot: LINE_TAG,
	event: 'window',
	run: 'r',
	bee: 'protocol-1',
	kind: 'protocol',
	at: at(180),
	stage: 'home',
	count: 900,
	failures: 0,
	statuses: { '200': 900 },
	ttfb: { '10': 900 },
	total: { '10': 900 },
})

const find = (release: string, lines: readonly BeeLine[] = []) => {
	const found = deployWindows(parseLedger(LEDGER, 'ledger.jsonl'), RUN, lines).find(
		deploy => deploy.release === release,
	)
	assert.ok(found, `no deploy ${release} was kept`)
	return found
}

describe('reading the deploy ledger', () => {
	it('refuses a line that is not a record, naming the file and the line', () => {
		const text = [
			entry('2026-11-01T12:00:00Z', 'deploy.started', INSIDE),
			'',
			'{"event":"deploy.fin',
		].join('\n')
		assert.throws(() => parseLedger(text, 'showcase.audit.jsonl'), {
			message: /showcase\.audit\.jsonl, line 3: not JSON/,
		})
	})

	it('refuses a record without an event or without a time it can read', () => {
		assert.throws(
			() => parseLedger('["deploy.started"]', 'l.jsonl'),
			/l\.jsonl, line 1: not a JSON object/,
		)
		assert.throws(
			() => parseLedger('{"recorded_at":"2026-11-01T12:00:00Z"}', 'l.jsonl'),
			/line 1: no "event"/,
		)
		assert.throws(
			() => parseLedger('{"event":"deploy.started","recorded_at":"yesterday"}', 'l.jsonl'),
			/line 1: "recorded_at" is not a UTC time/,
		)
		assert.throws(
			() =>
				parseLedger('{"event":"deploy.started","recorded_at":"2026-13-45T99:00:00Z"}', 'l.jsonl'),
			/line 1: "recorded_at" is not a UTC time/,
		)
	})

	it('reads blank lines as nothing and every record in file order', () => {
		const records = parseLedger(`${LEDGER}\n\n`, 'ledger.jsonl')
		assert.equal(records.length, LEDGER.split('\n').length)
		assert.equal(records[0]?.event, 'deploy.started')
	})

	it('names a file it cannot read', () => {
		const missing = join(mkdtempSync(join(tmpdir(), 'drexbot-ledger-')), 'absent.jsonl')
		assert.throws(
			() => readLedger(missing),
			(error: Error) => error.message.includes(missing),
		)
	})
})

describe('which deploys a run crossed', () => {
	it('keeps the deploys inside the run and the margin, and leaves the others out', () => {
		const kept = deployWindows(parseLedger(LEDGER, 'ledger.jsonl'), RUN).map(
			deploy => deploy.release,
		)
		assert.deepEqual(kept, [JUST_BEFORE, INSIDE, NEVER_CLOSED])
		assert.equal(DEPLOY_MARGIN_SECONDS, 60)
	})

	it('records a deploy in seconds from the run start as well as in the ledger time', () => {
		const deploy = find(INSIDE)
		assert.equal(deploy.env, 'showcase')
		assert.equal(deploy.outcome, 'success')
		assert.equal(deploy.startedAt, '2026-11-01T12:00:50Z')
		assert.equal(deploy.endedAt, '2026-11-01T12:01:50Z')
		assert.equal(deploy.startedSeconds, 50)
		assert.equal(deploy.endedSeconds, 110)
		assert.equal(deploy.seconds, 60)
	})

	it('records the maintenance window from enabled to disabled', () => {
		const window = find(INSIDE).maintenance
		assert.deepEqual(window, {
			startedAt: '2026-11-01T12:01:10Z',
			endedAt: '2026-11-01T12:01:30Z',
			startedSeconds: 70,
			endedSeconds: 90,
			seconds: 20,
			closed: true,
		})
	})

	it('records each phase the deploy opened, with its times', () => {
		const phases = Object.fromEntries(find(INSIDE).phases.map(phase => [phase.name, phase]))
		assert.deepEqual(Object.keys(phases), ['build', 'upload', 'cutover', 'setup:upgrade'])
		assert.equal(phases['build']?.startedSeconds, 52)
		assert.equal(phases['build']?.seconds, 13)
		assert.equal(phases['cutover']?.endedAt, '2026-11-01T12:01:40Z')
		assert.equal(phases['setup:upgrade']?.seconds, 13)
	})

	it('says a window never closed when no maintenance.disabled follows it', () => {
		const deploy = find(NEVER_CLOSED)
		assert.equal(deploy.outcome, 'failed')
		assert.equal(deploy.maintenance?.closed, false)
		assert.equal(deploy.maintenance?.startedSeconds, 155)
		assert.equal(deploy.maintenance?.endedAt, undefined)
		assert.equal(deploy.maintenance?.seconds, undefined)
		const upgrade = deploy.phases.find(phase => phase.name === 'setup:upgrade')
		assert.equal(upgrade?.endedAt, '2026-11-01T12:02:50Z')
	})

	it('closes a window on the record a person appended, and says so', () => {
		const byHand = `${LEDGER}\n${entry('2026-11-01T12:02:58Z', 'maintenance.disabled', NEVER_CLOSED, { by_hand: true })}`
		const deploy = deployWindows(parseLedger(byHand, 'ledger.jsonl'), RUN).find(
			found => found.release === NEVER_CLOSED,
		)
		assert.equal(deploy?.maintenance?.closed, true)
		assert.equal(deploy?.maintenance?.closedByHand, true)
		assert.equal(deploy?.maintenance?.seconds, 23)
	})

	it('reads a deploy that has no closing record as not closed', () => {
		const open = [entry('2026-11-01T12:01:00Z', 'deploy.started', INSIDE)].join('\n')
		const [deploy] = deployWindows(parseLedger(open, 'ledger.jsonl'), RUN)
		assert.equal(deploy?.outcome, 'not closed')
		assert.equal(deploy?.endedAt, undefined)
	})

	it('times a release deployed twice as two deploys', () => {
		const twice = [
			entry('2026-11-01T12:00:10Z', 'deploy.started', INSIDE),
			entry('2026-11-01T12:00:20Z', 'deploy.failed', INSIDE, { phase: 'build' }),
			entry('2026-11-01T12:01:00Z', 'deploy.started', INSIDE),
			entry('2026-11-01T12:01:30Z', 'deploy.finished', INSIDE, { outcome: 'rolled_back' }),
		].join('\n')
		const deploys = deployWindows(parseLedger(twice, 'ledger.jsonl'), RUN)
		assert.deepEqual(
			deploys.map(deploy => [deploy.outcome, deploy.startedSeconds]),
			[
				['failed', 10],
				['rolled_back', 60],
			],
		)
	})
})

describe('the run read before, during and after a deploy', () => {
	const lines = [...browserLines([80, 90]), protocolLine()]

	it('splits the browser bees windows around the deploy and around its maintenance window', () => {
		const [deploySplit, maintenanceSplit] = find(INSIDE, lines).splits
		assert.equal(deploySplit?.around, 'deploy')
		assert.deepEqual(
			[deploySplit?.before.windows, deploySplit?.during.windows, deploySplit?.after.windows],
			[5, 6, 7],
		)
		assert.deepEqual(
			[deploySplit?.before.failures, deploySplit?.during.failures, deploySplit?.after.failures],
			[0, 20, 0],
		)
		assert.equal(maintenanceSplit?.around, 'maintenance window')
		assert.deepEqual(
			[
				maintenanceSplit?.before.windows,
				maintenanceSplit?.during.windows,
				maintenanceSplit?.after.windows,
			],
			[7, 2, 9],
		)
		assert.equal(maintenanceSplit?.during.requests, 20)
		assert.equal(maintenanceSplit?.during.failures, 20)
	})

	it('reads p95 from the windows on that side alone, and leaves protocol requests out', () => {
		const [, maintenanceSplit] = find(INSIDE, lines).splits
		assert.ok((maintenanceSplit?.before.ttfbP95 ?? 0) < 200)
		assert.ok((maintenanceSplit?.during.ttfbP95 ?? 0) >= 3_000)
		assert.ok((maintenanceSplit?.after.ttfbP95 ?? 0) < 200)
		const requests = find(INSIDE, lines).splits.map(
			split => split.before.requests + split.during.requests + split.after.requests,
		)
		assert.deepEqual(requests, [180, 180])
	})

	it('has nothing after a window that never closed', () => {
		const [, maintenanceSplit] = find(NEVER_CLOSED, lines).splits
		assert.equal(maintenanceSplit?.after.windows, 0)
		assert.equal(maintenanceSplit?.during.windows, 3)
	})

	it('does not fake a split for a run with no interval windows', () => {
		assert.deepEqual(find(INSIDE, [protocolLine()]).splits, [])
		const report = deployReport(ledgerFile(LEDGER), RUN, [protocolLine()])
		const text = renderDeploys(report, true).join('\n')
		assert.match(text, /protocol bees write one window for the whole run, so they are not split/)
		assert.doesNotMatch(text, /before/)
	})
})

const ledgerFile = (text: string): string => {
	const directory = mkdtempSync(join(tmpdir(), 'drexbot-ledger-'))
	const file = join(directory, 'showcase.audit.jsonl')
	writeFileSync(file, text)
	return file
}

describe('the deploys in the run record', () => {
	it('prints one line per deploy, its maintenance window and the split', () => {
		const report = deployReport(ledgerFile(LEDGER), RUN, browserLines([80, 90]))
		const text = renderDeploys(report, false).join('\n')
		assert.match(text, new RegExp(`deploy ${INSIDE} on showcase: success, \\+50s to \\+110s, 60s`))
		assert.match(
			text,
			/maintenance window: \+70s to \+90s, 20s \(2026-11-01T12:01:10Z to 2026-11-01T12:01:30Z\)/,
		)
		assert.match(text, new RegExp(`deploy ${NEVER_CLOSED} on showcase: failed`))
		assert.match(
			text,
			/maintenance window: opened \+155s .* not closed: no maintenance\.disabled follows it/,
		)
		assert.match(text, /before\s+7 windows\s+70 requests\s+0 failed/)
		assert.match(text, /during\s+2 windows\s+20 requests\s+20 failed \(100\.00%\)/)
	})

	it('says plainly when the ledger holds no deploy in the run', () => {
		const quiet = [
			entry('2026-11-01T09:00:00Z', 'deploy.started', EARLIER),
			entry('2026-11-01T09:02:00Z', 'deploy.finished', EARLIER, { outcome: 'success' }),
		].join('\n')
		const report = deployReport(ledgerFile(quiet), RUN, browserLines([]))
		assert.deepEqual(report.deploys, [])
		assert.equal(report.records, 2)
		assert.match(
			renderDeploys(report, false).join('\n'),
			/no deploy in .*showcase\.audit\.jsonl fell within the run, give or take 60s \(2 records read\)/,
		)
	})

	it('records a refused ledger as refused rather than losing the run', () => {
		const report = deployReport(ledgerFile(`${LEDGER}\nnot a record`), RUN, [])
		assert.match(report.refused ?? '', /showcase\.audit\.jsonl, line 24: not JSON/)
		assert.deepEqual(report.deploys, [])
		assert.match(renderDeploys(report, false).join('\n'), /DEPLOY LEDGER REFUSED: .*line 24/)
	})

	it('adds nothing to a record that names no ledger', () => {
		const text = renderRecord(recordOf())
		assert.doesNotMatch(text, /deploy/i)
	})

	it('puts the deploys between the store line and the teardown line', () => {
		const text = renderRecord(
			recordOf({ deploys: deployReport(ledgerFile(LEDGER), RUN, browserLines([80, 90])) }),
		)
		assert.ok(text.indexOf('the store, under both') < text.indexOf(`deploy ${INSIDE}`))
		assert.ok(text.indexOf(`deploy ${INSIDE}`) < text.indexOf('teardown verified'))
	})
})

const shape: Shape = {
	browser: { bees: 1, workers: 2, cpus: 1, memory: bytesOf('1536m') },
	protocol: { bees: 0, users: 0, cpus: 1, memory: bytesOf('512m') },
	seconds: 180,
}

const recordOf = (overrides: Partial<RunRecord> = {}): RunRecord => ({
	drexbot: RECORD_TAG,
	run: 'run-showcase',
	...RUN,
	target: 'http://store.example:8080/',
	host: 'bees',
	via: 'docker',
	shape,
	shapeKey: shapeKey(shape, 'bees', 'docker'),
	result: reconcile(browserLines([]), 180),
	teardown: { removed: 1, leftover: 0, verified: true },
	caveats: [],
	...overrides,
})

/** `swarm reconcile` over an invented AWS download, with standard output held for the test to read. */
const reconcileWith = async (
	extra: readonly string[],
): Promise<{ code: number; output: string; written: RunRecord | undefined }> => {
	const root = mkdtempSync(join(tmpdir(), 'drexbot-reconcile-'))
	const download = join(root, 'download')
	mkdirSync(download)
	writeFileSync(
		join(download, 'plan.json'),
		JSON.stringify({ run: 'aws-showcase', url: 'http://store.example:8080/', shape }),
	)
	writeFileSync(
		join(download, 'bee-lines.txt'),
		`${browserLines([80, 90])
			.map(line => JSON.stringify(line))
			.join('\n')}\n`,
	)
	const results = join(root, 'results')
	const harness = { workspace: { results, root } } as unknown as Harness
	const out: string[] = []
	const write = process.stdout.write.bind(process.stdout)
	process.stdout.write = (chunk: string | Uint8Array) => {
		out.push(String(chunk))
		return true
	}
	try {
		const code = await swarmCommand(harness, {} as Options, ['reconcile', download, ...extra])
		const directory = join(results, 'swarm')
		const file = existsSync(directory)
			? readdirSync(directory).find(name => name.endsWith('.json'))
			: undefined
		const written =
			file === undefined
				? undefined
				: (JSON.parse(readFileSync(join(directory, file), 'utf8')) as RunRecord)
		return { code, output: out.join(''), written }
	} finally {
		process.stdout.write = write
	}
}

describe('swarm reconcile with a deploy ledger', () => {
	it('is unchanged without the flag', async () => {
		const { code, output, written } = await reconcileWith([])
		assert.equal(code, 0)
		assert.equal(written?.deploys, undefined)
		assert.doesNotMatch(output, /deploy/i)
	})

	it('records the deploys the run crossed when the ledger is named', async () => {
		const { code, output, written } = await reconcileWith(['--deploy-ledger', ledgerFile(LEDGER)])
		assert.equal(code, 0)
		assert.deepEqual(
			written?.deploys?.deploys.map(deploy => deploy.release),
			[JUST_BEFORE, INSIDE, NEVER_CLOSED],
		)
		assert.match(output, new RegExp(`deploy ${INSIDE} on showcase: success`))
	})

	it('exits 1 and still writes the record when the ledger has a line it cannot read', async () => {
		const { code, output, written } = await reconcileWith([
			'--deploy-ledger',
			ledgerFile(`${LEDGER}\n{broken`),
		])
		assert.equal(code, 1)
		assert.match(output, /DEPLOY LEDGER REFUSED: .*line 24: not JSON/)
		assert.match(written?.deploys?.refused ?? '', /line 24/)
	})

	it('refuses a flag with no file after it', async () => {
		const { code } = await reconcileWith(['--deploy-ledger'])
		assert.equal(code, 1)
	})
})

describe('swarm run with a deploy ledger it cannot read', () => {
	/** `swarm run` as far as it gets, with standard error held; it must stop before any bee, plan or Docker call. */
	const runWith = async (argv: readonly string[]): Promise<{ code: number; errors: string }> => {
		const errors: string[] = []
		const write = process.stderr.write.bind(process.stderr)
		process.stderr.write = (chunk: string | Uint8Array) => {
			errors.push(String(chunk))
			return true
		}
		try {
			const code = await swarmCommand({} as Harness, {} as Options, ['run', ...argv])
			return { code, errors: errors.join('') }
		} finally {
			process.stderr.write = write
		}
	}

	it('stops with exit code 2 before starting anything, naming the file and the line', async () => {
		const file = ledgerFile(`${LEDGER}\n{broken`)
		const { code, errors } = await runWith(['--deploy-ledger', file])
		assert.equal(code, 2)
		assert.ok(errors.includes(`${file}, line 24: not JSON`), errors)
	})

	it('stops with exit code 2 for a ledger that is not there, and for a flag with no file', async () => {
		const missing = join(mkdtempSync(join(tmpdir(), 'drexbot-ledger-')), 'absent.jsonl')
		assert.equal((await runWith(['--deploy-ledger', missing])).code, 2)
		assert.equal((await runWith(['--deploy-ledger'])).code, 2)
		assert.match((await runWith(['--deploy-ledger', '--seconds', '60'])).errors, /needs a file/)
	})
})
