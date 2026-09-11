import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startThemeServer, type ThemeServer } from '../fixtures/theme-pages.js'
import { DriftRecorder, judgeDrift, recordDrift, emptyDrift } from 'harness-kernel'
import { BrowserSurface } from '../src/surfaces/browser.js'
import { LUMA_MESSAGES, LUMA_PROFILE } from '../src/magento/selectors.js'

let server: ThemeServer

before(async () => {
	server = await startThemeServer()
})

after(async () => {
	await server.close()
})

const drive = async <T>(
	theme: string,
	body: Parameters<BrowserSurface['visit']>[1],
	recorder = new DriftRecorder(),
): Promise<{ recorder: DriftRecorder; result: T }> => {
	const surface = await BrowserSurface.launch({
		baseUrl: server.url,
		profile: LUMA_PROFILE,
		messages: LUMA_MESSAGES,
		recorder,
	})
	try {
		const result = (await surface.visit(`/${theme}`, body)) as T
		return { recorder, result }
	} finally {
		await surface.close()
	}
}

describe('one profile against storefronts that share no markup', () => {
	it('finds the search box, the title and the products on a semantic page', async () => {
		await drive('semantic', async ({ find }) => {
			assert.equal(await (await find('pageTitle')).first().innerText(), 'Search results')
			assert.equal(await (await find('productTile')).count(), 2)
			assert.equal(await (await find('productLink')).first().innerText(), 'A shirt')
			await (await find('searchInput', { unique: true })).fill('bag')
		})
	})

	it('finds the same things on a themed page with no semantic markup at all', async () => {
		// The two pages share no id and no class. If this passes on both, the
		// ordering is doing what the ordering is for.
		await drive('themed', async ({ find }) => {
			assert.equal(await (await find('pageTitle')).first().innerText(), 'Search results')
			assert.equal(await (await find('productTile')).count(), 1)
			assert.equal(await (await find('productPrice')).first().innerText(), '$29.00')
			await (await find('searchInput', { unique: true })).fill('bag')
		})
	})

	it('reports what is actually on the page when nothing resolves', async () => {
		// A proposal, never an application: the report says what was there, and a
		// person decides. Repairing itself would stop it testing what it claims to.
		await assert.rejects(
			() => drive('unrecognisable', async ({ find }) => void (await find('productTile'))),
			(error: Error) => {
				assert.match(error.message, /could not find "productTile"/)
				assert.match(error.message, /Tried, in order/)
				assert.match(error.message, /What is visible and interactive/)
				assert.match(error.message, /button "Do a thing"/)
				return true
			},
		)
	})
})

describe('the drift ledger', () => {
	it('records which candidate answered, not merely that one did', async () => {
		const { recorder } = await drive('semantic', async ({ find }) => {
			await find('pageTitle')
		})

		const title = recorder.best().get('pageTitle')
		assert.equal(title?.index, 0)
		assert.equal(title?.candidate, 'h1')
	})

	it('notices an entry answering further down the list than it used to', async () => {
		const semantic = await drive('semantic', async ({ find }) => void (await find('pageTitle')))
		const history = recordDrift(semantic.recorder, emptyDrift())

		const drifted = await drive('drifted', async ({ find }) => void (await find('pageTitle')))
		const reported = judgeDrift(drifted.recorder, history, {
			target: 'stub',
			runId: 'run-1',
			startedAt: '2026-08-27T00:00:00.000Z',
		})

		assert.equal(reported.length, 1)
		assert.equal(reported[0]?.verdict, 'degraded')
		assert.match(reported[0]?.reason ?? '', /pageTitle answered on candidate 3 of 3/)
		assert.match(reported[0]?.reason ?? '', /it used to answer on candidate 1 \("h1"\)/)
	})

	it('says nothing when the entry answers where it always has', async () => {
		const first = await drive('semantic', async ({ find }) => void (await find('pageTitle')))
		const history = recordDrift(first.recorder, emptyDrift())

		const second = await drive('semantic', async ({ find }) => void (await find('pageTitle')))
		const reported = judgeDrift(second.recorder, history, {
			target: 'stub',
			runId: 'run-2',
			startedAt: '2026-08-27T00:00:00.000Z',
		})

		assert.deepEqual(reported, [])
	})

	it('does not call a drifted entry a failure', async () => {
		// It resolved. The check passed. Drift is the markup moving toward the
		// bottom of the list, which is the last quiet moment before it stops
		// resolving at all.
		const drifted = await drive('drifted', async ({ find }) => {
			assert.equal(await (await find('pageTitle')).first().innerText(), 'Search results')
		})
		assert.equal(drifted.recorder.best().get('pageTitle')?.index, 2)
	})
})

describe('asking whether something a shopper can see is there', () => {
	it('does not read a payment step hidden on the shipping step as present', async () => {
		const { recorder, result } = await drive<boolean>('checkout-shipping', ({ present }) =>
			present('paymentStep', { visible: true, timeoutMs: 500 }),
		)

		assert.equal(result, false)
		// A hidden element must not teach the ledger that a candidate answered.
		assert.equal(recorder.best().get('paymentStep'), undefined)
	})

	it('reads the payment step as present once it is shown', async () => {
		const { recorder, result } = await drive<boolean>('checkout-payment', ({ present }) =>
			present('paymentStep', { visible: true, timeoutMs: 500 }),
		)

		assert.equal(result, true)
		assert.equal(recorder.best().get('paymentStep')?.candidate, '#checkout-step-payment')
	})

	it('still counts a hidden element when visibility is not asked for', async () => {
		// Checks such as the unavailable-payment count rely on this, so asking for
		// visibility is a choice at the call and never the default.
		const { recorder, result } = await drive<boolean>('checkout-shipping', ({ present }) =>
			present('paymentStep', { timeoutMs: 500 }),
		)

		assert.equal(result, true)
		assert.equal(recorder.best().get('paymentStep')?.index, 0)
	})
})

describe('a failure reports what the page is saying', () => {
	/** Drives a theme with no `messages` declared, so the quiet direction is real. */
	const driveSilent = async (theme: string, body: Parameters<BrowserSurface['visit']>[1]) => {
		const surface = await BrowserSurface.launch({
			baseUrl: server.url,
			profile: LUMA_PROFILE,
			recorder: new DriftRecorder(),
		})
		try {
			return await surface.visit(`/${theme}`, body)
		} finally {
			await surface.close()
		}
	}

	it('names the banner the page is showing instead of the entry that is missing', async () => {
		// Reporting only "could not find successMessage" hands back a selector
		// problem for a store that has already said what went wrong.
		await drive('erroring', async ({ find }) => {
			const failure = await find('successMessage', { timeoutMs: 500 }).then(
				() => undefined,
				(error: Error) => error,
			)

			assert.ok(failure, 'expected the missing entry to fail')
			assert.match(failure.message, /The page is saying: error — "PayPal Checkout could not be/)
			assert.match(failure.message, /could not find "successMessage"/)
		})
	})

	it('says nothing about messages when the target declares none', async () => {
		// The counter-direction, and it is what stops the line being decoration: a
		// surface with no message candidates must not invent one.
		await driveSilent('erroring', async ({ find }) => {
			const failure = await find('successMessage', { timeoutMs: 500 }).then(
				() => undefined,
				(error: Error) => error,
			)

			assert.ok(failure)
			assert.doesNotMatch(failure.message, /The page is saying/)
		})
	})

	it('says nothing about messages on a page that carries none', async () => {
		await drive('semantic', async ({ find }) => {
			const failure = await find('successMessage', { timeoutMs: 500 }).then(
				() => undefined,
				(error: Error) => error,
			)

			assert.ok(failure)
			assert.doesNotMatch(failure.message, /The page is saying/)
		})
	})

	it('never teaches the drift ledger about a message it read', async () => {
		// A banner is read only when something has already failed, so its history
		// would be a record of bad days rather than of markup moving. Recording it
		// would put an entry in the ledger that no healthy run ever touches.
		const { recorder } = await drive('erroring', async ({ find }) => {
			await find('successMessage', { timeoutMs: 500 }).catch(() => undefined)
		})

		assert.deepEqual([...recorder.best().keys()], [])
	})
})
