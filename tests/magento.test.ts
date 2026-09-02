import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startStorefrontStub, type StoreDefect } from '../fixtures/storefront-stub.js'
import { defaultEnvironment } from '@harness/kernel'
import { retryPolicy } from '@harness/kernel'
import { startRun } from '@harness/kernel'
import { preflightObservation, runChecks } from '@harness/kernel'
import { summarize } from '@harness/kernel'
import { magentoTarget } from '../src/magento/adapter.js'

const against = async (defect: StoreDefect, suite = 'session-less') => {
	const stub = await startStorefrontStub(defect)
	try {
		const target = magentoTarget({
			baseUrl: stub.url,
			environment: 'stub',
			// The fixture store's own facts, so the checks are not blocked on a
			// baseline that was never captured for it.
			store: {
				captured: true,
				capturedAt: '2026-08-27T00:00:00.000Z',
				baseUrl: stub.url,
				storeCode: 'default',
				currency: 'USD',
				categoryPath: '/women/tops-women.html',
				categoryProducts: 12,
				searchTerm: 'bag',
				searchResults: 8,
			},
		})
		const preflight = await target.preflight()
		const run = startRun({
			target: target.name,
			environment: target.environment,
			suites: [suite],
			seed: 'fixed',
		})
		const environment = defaultEnvironment(run, target.capabilities, {
			retry: retryPolicy({ baseDelayMs: 0 }),
			sleep: async () => undefined,
		})

		const checks = target.suites().get(suite) ?? []
		const observations = await runChecks(checks, environment)
		return {
			preflight,
			preflightObservation: preflightObservation(preflight, target.name, run.id, run.startedAt),
			observations,
			summary: summarize(observations),
		}
	} finally {
		await stub.close()
	}
}

const failedIds = (observations: readonly { id: string; verdict: string }[]): string[] =>
	observations
		.filter(observation => observation.verdict === 'fail')
		.map(observation => observation.id)

describe('preflight against a Magento store', () => {
	it('records the edition and version the store reports', async () => {
		const { preflight } = await against('none')

		assert.equal(preflight.reachable, true)
		assert.equal(preflight.build, 'Magento/2.4 (Enterprise)')
	})

	it('blocks the run when the store will not identify itself', async () => {
		const { preflight, preflightObservation: observation } = await against('no-version')

		assert.equal(preflight.reachable, false)
		assert.equal(observation.verdict, 'blocked')
		assert.match(observation.reason ?? '', /answered 404/)
	})
})

describe('the storefront smoke suite', () => {
	it('passes against a store that renders', async () => {
		const { summary } = await against('none', 'smoke')
		assert.equal(summary.red, false)
	})

	it('catches a 200 that is really an error page', async () => {
		// The reason every smoke check asserts a body marker: Magento answers 200
		// with a rendered error page, and a status-only check calls that healthy.
		const { observations, summary } = await against('error-page-200', 'smoke')

		assert.equal(summary.red, true)
		assert.ok(failedIds(observations).includes('magento.smoke.home'))
		const home = observations.find(observation => observation.id === 'magento.smoke.home')
		assert.match(home?.reason ?? '', /does not contain "cms-index-index"/)
	})
})

describe('the storefront session-less suite', () => {
	it('passes against a store that refuses what it should', async () => {
		const { observations, summary } = await against('none')

		assert.equal(summary.red, false)
		assert.deepEqual(failedIds(observations), [])
	})

	it('catches env.php being served, and says what it leaks', async () => {
		const { observations } = await against('env-php-served')
		const failure = observations.find(observation => observation.verdict === 'fail')

		assert.equal(failure?.id, 'magento.session-less.not-served.app-etc-env-php')
		assert.match(failure?.reason ?? '', /database password and the crypt key/)
	})

	it('catches an admin that serves the dashboard without a session', async () => {
		// Both the login page and the dashboard answer 200, so the status is not
		// the evidence — which of the two came back is.
		const { observations } = await against('admin-open')

		assert.deepEqual(failedIds(observations).sort(), [
			'magento.session-less.admin-deep-link',
			'magento.session-less.admin-is-a-login-form',
		])
	})

	it('catches REST resources answering a caller with no token', async () => {
		const { observations } = await against('rest-open')
		const failed = failedIds(observations)

		assert.equal(failed.length, 4)
		assert.ok(failed.every(id => id.startsWith('magento.session-less.rest.')))
	})

	it('keeps the public REST resource passing, so a 401 means authentication and not an outage', async () => {
		const { observations } = await against('none')
		const publicProbe = observations.find(
			observation => observation.id === 'magento.session-less.rest.directory-countries',
		)

		assert.equal(publicProbe?.verdict, 'pass')
	})
})

describe('whether the store may be written to', () => {
	// Nothing here can undo a registration or an order, so the default has to be
	// the refusing one.
	const withDisposable = <T>(value: string | undefined, body: () => T): T => {
		const before = process.env['MAGENTO_DISPOSABLE']
		if (value === undefined) delete process.env['MAGENTO_DISPOSABLE']
		else process.env['MAGENTO_DISPOSABLE'] = value
		try {
			return body()
		} finally {
			if (before === undefined) delete process.env['MAGENTO_DISPOSABLE']
			else process.env['MAGENTO_DISPOSABLE'] = before
		}
	}

	it('refuses by default, so an unvouched store is never written to', () => {
		const capabilities = withDisposable(undefined, () => magentoTarget().capabilities)

		assert.equal(capabilities.isDisposable, false)
	})

	it('is granted only by the environment saying so exactly', () => {
		assert.equal(withDisposable('1', () => magentoTarget().capabilities).isDisposable, true)

		// Every other value is a refusal. `0` and `false` are what somebody turning
		// it off would write, and a truthiness test would have granted both.
		for (const value of ['0', 'false', 'no', '', 'true', 'yes', '2']) {
			assert.equal(
				withDisposable(value, () => magentoTarget().capabilities).isDisposable,
				false,
				`MAGENTO_DISPOSABLE=${value} must not grant a destructive run`,
			)
		}
	})
})
