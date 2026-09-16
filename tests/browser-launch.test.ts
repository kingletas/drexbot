import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import { classify, PreconditionFailure, TransportFailure } from 'harness-kernel'
import { chromium } from 'playwright'
import { startStorefrontStub } from '../fixtures/storefront-stub.js'
import { launchFailure } from '../src/surfaces/browser-launch.js'

const WRAPPER = join(import.meta.dirname, '..', '..', 'bin', 'drexbot')

const DIST = join(import.meta.dirname, '..')

/** Runs the journey suite in a child, because Playwright reads where its browsers live when it is imported. */
const JOURNEY_RUN = `
import { defaultEnvironment, retryPolicy, runChecks, startRun } from 'harness-kernel'
import { magentoTarget } from ${JSON.stringify(join(DIST, 'src', 'magento', 'adapter.js'))}

const baseUrl = process.env.STUB_URL
const target = magentoTarget({
	baseUrl,
	environment: 'stub',
	store: { captured: true, capturedAt: '2026-08-27T00:00:00.000Z', baseUrl, storeCode: 'default',
		currency: 'USD', categoryPath: '/women/tops-women.html', categoryProducts: 12,
		searchTerm: 'bag', searchResults: 8 },
})
const run = startRun({ target: target.name, environment: target.environment, suites: ['journey'], seed: 'fixed' })
const environment = defaultEnvironment(run, target.capabilities, {
	retry: retryPolicy({ baseDelayMs: 0 }),
	sleep: async () => undefined,
})
const observations = await runChecks(target.suites().get('journey') ?? [], environment)
await target.dispose?.()
process.stdout.write(JSON.stringify(observations.map(o => ({ verdict: o.verdict, reason: o.reason }))))
`

describe('a browser that cannot start', () => {
	let scratch = ''

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), 'drexbot-launch-'))
	})

	after(() => rmSync(scratch, { recursive: true, force: true }))

	/** What Playwright really throws when the executable it starts exits at once, writing this to stderr. */
	const realLaunchError = async (stderr: string): Promise<unknown> => {
		const executable = join(scratch, `chrome-${Math.random().toString(36).slice(2)}`)
		writeFileSync(executable, `#!/bin/sh\necho "${stderr}" >&2\nexit 127\n`)
		chmodSync(executable, 0o755)
		try {
			await chromium.launch({ executablePath: executable, timeout: 15_000 })
		} catch (error) {
			return error
		}
		assert.fail('the fake browser started')
	}

	it('names a missing system library as a precondition with its fix', async () => {
		const failure = launchFailure(
			await realLaunchError(
				'chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory',
			),
		)

		assert.ok(failure instanceof PreconditionFailure)
		assert.equal(classify(failure), 'precondition')
		assert.match(failure.message, /missing a system library \(libnspr4\.so\)/)
		assert.match(failure.message, /On Debian or Ubuntu, including WSL, run `make browser-deps`/)
		assert.match(
			failure.message,
			/Elsewhere, install Chromium's libraries with your package manager/,
		)
		assert.ok(failure.cause instanceof Error, 'the original launch error is kept as the cause')
	})

	it('recognises the error as a fresh WSL machine reports it', () => {
		const shell =
			'/home/someone/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell'
		const failure = launchFailure(
			new Error(
				[
					'browserType.launch: Target page, context or browser has been closed',
					'Browser logs:',
					'',
					`<launching> ${shell} --disable-field-trial-config --headless --no-sandbox`,
					'<launched> pid=10954',
					`[pid=10954][err] ${shell}: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory`,
					'Call log:',
					`  - <launching> ${shell} --disable-field-trial-config --headless --no-sandbox`,
					'  - <launched> pid=10954',
					`  - [pid=10954][err] ${shell}: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory`,
				].join('\n'),
			),
		)

		assert.ok(failure instanceof PreconditionFailure)
		assert.match(failure.message, /missing a system library \(libnspr4\.so\)/)
	})

	it("names Playwright's own missing-dependencies report the same way", () => {
		const failure = launchFailure(
			new Error('browserType.launch: \nHost system is missing dependencies to run browsers.'),
		)

		assert.ok(failure instanceof PreconditionFailure)
		assert.match(failure.message, /missing system libraries it needs/)
	})

	it('leaves a failure it does not recognise as a transport failure', async () => {
		const failure = launchFailure(await realLaunchError('something else went wrong'))

		assert.ok(failure instanceof TransportFailure)
		assert.equal(classify(failure), 'transport')
		assert.ok(failure.cause instanceof Error)
		assert.match(failure.message, /^could not start a browser: /)
	})

	it('blocks a browser check with the fix instead of failing it', async () => {
		const stub = await startStorefrontStub('none')
		try {
			// Asynchronous, so this process keeps serving the stub store while the child runs.
			const { stdout } = await promisify(execFile)(
				process.execPath,
				['--input-type=module', '-e', JOURNEY_RUN],
				{
					cwd: join(DIST, '..'),
					env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: scratch, STUB_URL: stub.url },
					timeout: 120_000,
				},
			)

			const observations = JSON.parse(stdout) as { verdict: string; reason?: string }[]
			assert.ok(observations.length > 0)
			for (const observation of observations) {
				assert.equal(observation.verdict, 'blocked', observation.reason)
				assert.match(observation.reason ?? '', /Chromium is not installed/)
			}
		} finally {
			await stub.close()
		}
	})

	describe('drexbot browser', () => {
		const browserCommand = (env: Record<string, string> = {}) =>
			spawnSync('bash', [WRAPPER, 'browser'], {
				encoding: 'utf8',
				env: { ...process.env, ...env },
				timeout: 60_000,
			})

		it('fails and says to run make setup when Chromium is not installed', () => {
			const result = browserCommand({ PLAYWRIGHT_BROWSERS_PATH: scratch })

			assert.equal(result.status, 1, result.stdout)
			assert.match(
				result.stderr,
				/Chromium is not installed where this version of Playwright looks for it \(\S*chrom\S*\)\. Run `make setup`/,
			)
		})

		it('says Chromium starts when it does', () => {
			const result = browserCommand()

			assert.equal(result.status, 0, result.stderr)
			assert.equal(result.stdout, 'drexbot: Chromium starts on this machine\n')
		})
	})

	it('drexbot probe names why it could not run and exits 1, without a stack trace', () => {
		const result = spawnSync('bash', [WRAPPER, 'probe', '--target', 'magento'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PLAYWRIGHT_BROWSERS_PATH: scratch,
				MAGENTO_URL: 'https://127.0.0.1:9',
			},
			timeout: 60_000,
		})

		assert.equal(result.status, 1, result.stdout)
		assert.match(
			result.stderr,
			/^drexbot: could not probe magento — Chromium is not installed where this version of Playwright looks for it/,
		)
		assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr)
	})
})
