import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
	ArtefactStore,
	classify,
	defaultEnvironment,
	DriftRecorder,
	NO_CAPABILITIES,
	NO_RETRY,
	runCheck,
	startRun,
	type CheckDefinition,
} from 'harness-kernel'
import { startThemeServer, type ThemeServer } from '../fixtures/theme-pages.js'
import {
	BrowserSurface,
	closeInOrder,
	StepTimeout,
	within,
	type ClosableContext,
} from '../src/surfaces/browser.js'
import { LUMA_MESSAGES, LUMA_PROFILE } from '../src/magento/selectors.js'

const never = (): Promise<never> => new Promise(() => undefined)

/**
 * Behaves as Playwright does with a HAR recording after a navigation cut a
 * response off: the context will not finish closing while a page is open.
 */
const deadlockingContext = (): ClosableContext & { readonly open: () => number } => {
	let open = 2
	const pages = [0, 1].map(() => ({
		close: async () => {
			open -= 1
		},
	}))
	return {
		pages: () => pages,
		close: () => (open === 0 ? Promise.resolve() : never()),
		open: () => open,
	}
}

describe('a browser call with no timeout of its own', () => {
	it('fails by name once its bound passes, as a timeout the kernel will classify', async () => {
		const failure = await within(never(), 50, 'counting "pageTitle" (h1)').then(
			() => undefined,
			(error: unknown) => error,
		)

		assert.ok(failure instanceof StepTimeout)
		assert.equal(failure.message, 'counting "pageTitle" (h1) timed out after 0.05s')
		assert.equal(classify(failure), 'timeout')
	})

	it('hands back what the call returned when it answers in time', async () => {
		assert.equal(await within(Promise.resolve(3), 1_000, 'counting'), 3)
	})
})

describe('closing a context', () => {
	it('models the deadlock: the context alone never finishes closing', async () => {
		const context = deadlockingContext()
		await assert.rejects(within(context.close(), 50, 'closing'), StepTimeout)
		assert.equal(context.open(), 2)
	})

	it('closes the pages first, so the context can finish', async () => {
		const context = deadlockingContext()
		assert.deepEqual(await closeInOrder(context, 1_000), [])
		assert.equal(context.open(), 0)
	})

	it('names a close that stalls anyway, and still attempts the rest', async () => {
		let contextAsked = false
		const stalls = await closeInOrder(
			{
				pages: () => [{ close: never }],
				close: async () => {
					contextAsked = true
				},
			},
			50,
		)

		assert.deepEqual(
			stalls.map(stall => stall.message),
			['closing the page timed out after 0.05s'],
		)
		assert.equal(contextAsked, true)
	})
})

describe('a browser check run by the kernel', () => {
	let server: ThemeServer
	let surface: BrowserSurface

	before(async () => {
		server = await startThemeServer()
		surface = await BrowserSurface.launch({
			baseUrl: server.url,
			profile: LUMA_PROFILE,
			messages: LUMA_MESSAGES,
			recorder: new DriftRecorder(),
		})
	})

	after(async () => {
		await surface.close()
		await server.close()
	})

	const environment = (root: string) =>
		defaultEnvironment(
			startRun({ target: 'stub', environment: 'local', suites: ['journey'], seed: 'fixed' }),
			NO_CAPABILITIES,
			{ timeLimitMs: 2_000, retry: NO_RETRY, artefacts: new ArtefactStore(root) },
		)

	const browserCheck = (body: Parameters<BrowserSurface['visit']>[1]): CheckDefinition => ({
		id: 'stub.journey.page',
		title: 'A page',
		suite: 'journey',
		async body({ artefactDir, attach, signal }) {
			await surface.visit('/semantic', body, { dir: artefactDir, attach, signal })
		},
	})

	it('ends a check stuck in an unbounded wait with a verdict naming the step', async () => {
		const started = Date.now()
		const observation = await runCheck(
			browserCheck(async ({ page, find }) => {
				await find('pageTitle')
				// A wait with no limit at all, the shape of every hang this guards.
				await page.waitForFunction(() => false, undefined, { timeout: 0 })
			}),
			environment(mkdtempSync(join(tmpdir(), 'run-'))),
		)

		assert.equal(observation.verdict, 'fail')
		assert.match(
			observation.reason ?? '',
			/^timeout: ran past its 2s time limit, and was stopped in:/,
		)
		assert.match(observation.reason ?? '', /using "pageTitle" — page\.waitForFunction/)
		assert.ok(
			observation.artefacts.some(artefact => artefact.kind === 'trace'),
			'the stopped check should keep its trace',
		)
		assert.ok(Date.now() - started < 20_000, 'the verdict arrived long after the limit')
	})

	it('leaves a check that finishes in time passing, with no evidence kept', async () => {
		const observation = await runCheck(
			browserCheck(async ({ find }) => {
				assert.equal(await (await find('pageTitle')).first().innerText(), 'Search results')
			}),
			environment(mkdtempSync(join(tmpdir(), 'run-'))),
		)

		assert.equal(observation.verdict, 'pass')
		assert.deepEqual(observation.artefacts, [])
	})
})
