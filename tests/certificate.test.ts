import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import { classify, PreconditionFailure } from 'harness-kernel'
import { chromium } from 'playwright'
import { startStorefrontStub, type StubTls } from '../fixtures/storefront-stub.js'
import { isLocalStore, navigationFailure } from '../src/surfaces/certificate.js'

const DIST = join(import.meta.dirname, '..')

/** Runs the journey suite in a child, so Playwright reads a browser path this test controls. */
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
process.stdout.write(JSON.stringify(observations.map(o => ({ id: o.id, verdict: o.verdict, reason: o.reason }))))
`

describe('a certificate Chromium will not accept', () => {
	let scratch = ''

	/** Made for this run only, and signed by a root nothing on this machine trusts. */
	const certificateFor = (commonName: string): StubTls => {
		const name = commonName.replace(/\W/g, '')
		const openssl = (...args: string[]): void => {
			execFileSync('openssl', args, { cwd: scratch, stdio: 'ignore' })
		}
		openssl(
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-days',
			'1',
			'-subj',
			'/CN=Local Test CA',
			'-keyout',
			`ca-${name}.key`,
			'-out',
			`ca-${name}.pem`,
		)
		openssl(
			'req',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-subj',
			`/CN=${commonName}`,
			'-keyout',
			`leaf-${name}.key`,
			'-out',
			`leaf-${name}.csr`,
		)
		execFileSync('bash', ['-c', `printf 'subjectAltName=DNS:${commonName}\\n' > ext-${name}`], {
			cwd: scratch,
			stdio: 'ignore',
		})
		openssl(
			'x509',
			'-req',
			'-in',
			`leaf-${name}.csr`,
			'-CA',
			`ca-${name}.pem`,
			'-CAkey',
			`ca-${name}.key`,
			'-CAcreateserial',
			'-days',
			'1',
			'-extfile',
			`ext-${name}`,
			'-out',
			`leaf-${name}.pem`,
		)

		return {
			key: readFileSync(join(scratch, `leaf-${name}.key`)),
			cert: readFileSync(join(scratch, `leaf-${name}.pem`)),
		}
	}

	/** The error Chromium really raises for this store, rather than one written to match. */
	const realNavigationError = async (url: string): Promise<unknown> => {
		const browser = await chromium.launch()
		const page = await (await browser.newContext({ ignoreHTTPSErrors: false })).newPage()
		try {
			await page.goto(url)
		} catch (error) {
			return error
		} finally {
			await browser.close()
		}
		assert.fail(`${url} loaded`)
	}

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), 'drexbot-cert-'))
	})

	after(() => rmSync(scratch, { recursive: true, force: true }))

	it('tells a local store how to give Chromium the root, not NODE_EXTRA_CA_CERTS', async () => {
		const stub = await startStorefrontStub('none', certificateFor('localhost'))
		try {
			const failure = navigationFailure(await realNavigationError(stub.url), stub.url)

			assert.ok(failure instanceof PreconditionFailure)
			assert.equal(classify(failure), 'precondition')
			assert.match(failure.message, /ERR_CERT_AUTHORITY_INVALID/)
			assert.match(failure.message, /never reads NODE_EXTRA_CA_CERTS/)
			assert.match(failure.message, /certutil -d sql:\$HOME\/\.pki\/nssdb/)
			assert.ok(failure.cause instanceof Error)
		} finally {
			await stub.close()
		}
	})

	it('tells a public store to fix its chain instead', async () => {
		const stub = await startStorefrontStub('none', certificateFor('localhost'))
		try {
			const failure = navigationFailure(
				await realNavigationError(stub.url),
				'https://store.example',
			)

			assert.ok(failure instanceof PreconditionFailure)
			assert.match(failure.message, /does not reach a root Chromium trusts/)
			assert.doesNotMatch(failure.message, /certutil/)
		} finally {
			await stub.close()
		}
	})

	it('blocks the trust decisions that are not spelled ERR_CERT_, rather than retrying them', () => {
		for (const [code, says] of [
			['ERR_CERTIFICATE_TRANSPARENCY_REQUIRED', /certificate transparency log/],
			['ERR_BAD_SSL_CLIENT_AUTH_CERT', /asked for a client certificate/],
		] as const) {
			const failure = navigationFailure(
				new Error(`page.goto: net::${code} at https://vanilla-magento.test/`),
				'https://vanilla-magento.test',
			)

			assert.ok(failure instanceof PreconditionFailure, code)
			assert.equal(classify(failure), 'precondition', code)
			assert.match(failure.message, says, code)
		}
	})

	it('leaves a handshake failure a transport failure, because a retry can clear one', () => {
		const handshake = new Error('page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://store.test/')

		assert.equal(navigationFailure(handshake, 'https://store.test'), handshake)
	})

	// An untrusted root outranks every other certificate fault, so these two are the
	// messages Chromium gave when the root was trusted and only the name or date was wrong.
	it('names a certificate fault that trusting a root would not fix, and suggests no root', () => {
		const mismatch = navigationFailure(
			new Error('page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://localhost:32865/'),
			'https://vanilla-magento.test',
		)
		const expired = navigationFailure(
			new Error('page.goto: net::ERR_CERT_DATE_INVALID at https://localhost:32865/'),
			'https://vanilla-magento.test',
		)

		assert.ok(mismatch instanceof PreconditionFailure)
		assert.match(mismatch.message, /does not cover the hostname/)
		assert.doesNotMatch(mismatch.message, /certutil/)
		assert.ok(expired instanceof PreconditionFailure)
		assert.match(expired.message, /has expired, or is not valid yet/)
		assert.doesNotMatch(expired.message, /certutil/)
	})

	it('names a certificate fault it has no sentence for, without inventing one', () => {
		const failure = navigationFailure(
			new Error('page.goto: net::ERR_CERT_SYMANTEC_LEGACY at https://vanilla-magento.test/'),
			'https://vanilla-magento.test',
		)

		assert.ok(failure instanceof PreconditionFailure)
		assert.match(failure.message, /refused this store's certificate \(ERR_CERT_SYMANTEC_LEGACY\)/)
	})

	it('leaves a navigation failure that is not about a certificate alone', async () => {
		const refused = await realNavigationError('https://127.0.0.1:9/')

		assert.equal(navigationFailure(refused, 'https://127.0.0.1:9/'), refused)
	})

	it('knows a development store from a public one', () => {
		for (const local of [
			'https://vanilla-magento.test',
			'https://localhost:8443',
			'https://127.0.0.1',
		]) {
			assert.equal(isLocalStore(local), true, local)
		}
		for (const remote of ['https://store.example', 'https://evil.test.example.com']) {
			assert.equal(isLocalStore(remote), false, remote)
		}
	})

	it('blocks each browser check with the fix, and lets the rest of the run report', async () => {
		const stub = await startStorefrontStub('none', certificateFor('localhost'))
		try {
			const { stdout } = await promisify(execFile)(
				process.execPath,
				['--input-type=module', '-e', JOURNEY_RUN],
				{ cwd: join(DIST, '..'), env: { ...process.env, STUB_URL: stub.url }, timeout: 180_000 },
			)

			const observations = JSON.parse(stdout) as { id: string; verdict: string; reason?: string }[]
			assert.ok(observations.length > 1)
			for (const observation of observations) {
				assert.equal(observation.verdict, 'blocked', `${observation.id}: ${observation.reason}`)
				assert.match(observation.reason ?? '', /certutil/, observation.id)
			}
		} finally {
			await stub.close()
		}
	})
})
