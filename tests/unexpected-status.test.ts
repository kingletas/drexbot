import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startStorefrontStub, type StoreDefect } from '../fixtures/storefront-stub.js'
import { magentoTarget } from '../src/magento/adapter.js'
import { describeUnexpectedStatus } from '../src/magento/unexpected-status.js'

/** The preflight problem a stub carrying this defect produces, and the block that comes with it. */
const problemFrom = async (defect: StoreDefect): Promise<{ url: string; problem: string }> => {
	const stub = await startStorefrontStub(defect)
	try {
		const preflight = await magentoTarget({
			baseUrl: stub.url,
			environment: 'stub',
			store: {},
		}).preflight()

		assert.equal(preflight.reachable, false)
		assert.equal(preflight.build, 'unknown')
		return { url: stub.url, problem: preflight.problem ?? '' }
	} finally {
		await stub.close()
	}
}

describe('preflight against a store that answers something other than 200', () => {
	it('names what a front-end error page could be, and what to check', async () => {
		const { problem } = await problemFrom('proxy-404')

		assert.match(problem, /\/magento_version answered 404/)
		assert.match(problem, /The reply was text\/html and its body looks like an HTML error page\./)
		assert.match(problem, /a cache or proxy answering before Magento sees the path/)
		assert.match(problem, /Check what terminates TLS for this hostname/)
	})

	it('states a bare 404 plainly, with nothing to attribute it to', async () => {
		const { url, problem } = await problemFrom('no-version')

		assert.equal(
			problem,
			`${url}/magento_version answered 404. ` +
				'The reply was text/plain and its body is not an HTML page.',
		)
	})
})

describe('describeUnexpectedStatus', () => {
	const answer = (status: number, body = '', headers: Record<string, string> = {}): string =>
		describeUnexpectedStatus({
			baseUrl: 'https://store.example',
			path: '/magento_version',
			status,
			headers,
			body,
		})

	const html = { 'content-type': 'text/html; charset=UTF-8' }
	const MAGENTO_NOROUTE =
		'<!doctype html><html><body class="page-layout-1column cms-noroute-index">' +
		'<h1>Whoops, our bad...</h1></body></html>'

	it('always names the address, the status and the content type', () => {
		const problem = answer(404, 'not found', { 'content-type': 'text/plain' })

		assert.match(problem, /^https:\/\/store\.example\/magento_version answered 404\./)
		assert.match(problem, /The reply was text\/plain/)
	})

	it('says the body is empty rather than judging markup that is not there', () => {
		const problem = answer(404, '', html)

		assert.match(problem, /its body is empty\./)
		assert.doesNotMatch(problem, /HTML error page/)
		assert.doesNotMatch(problem, /cache or proxy/)
	})

	it('names no content type when the reply carried none', () => {
		assert.match(answer(404, 'not found'), /The reply named no content type/)
	})

	it('judges the body rather than the content type it was labelled with', () => {
		// A text/html label on a body with no markup is the header disagreeing with
		// what was sent, and the markup is the half a reader can act on.
		const problem = answer(404, 'not found', html)

		assert.match(
			problem,
			/The reply was text\/html; charset=UTF-8 and its body is not an HTML page/,
		)
		assert.doesNotMatch(problem, /cache or proxy/)
	})

	it('separates Magento answering for itself from something answering in front of it', () => {
		const magento = answer(404, MAGENTO_NOROUTE, html)
		assert.match(magento, /the store itself answered and does not serve this route/)
		assert.match(magento, /headless or route-narrowed storefront/)
		assert.doesNotMatch(magento, /cache or proxy/)

		const other = answer(404, '<html><head><title>404 Not Found</title></head></html>', html)
		assert.match(other, /a cache or proxy answering before Magento sees the path/)
		assert.doesNotMatch(other, /the store itself answered/)
	})

	it('reads a versioned static path as Magento having rendered the page', () => {
		const rendered =
			'<!doctype html><html><head>' +
			'<link href="https://store.example/static/version1756329600/frontend/Magento/luma/en_US/css/styles.css">' +
			'</head><body>Not Found</body></html>'

		assert.match(answer(404, rendered, html), /the store itself answered/)
	})

	it('names the address a redirect points at, because redirects are not followed', () => {
		const problem = answer(301, '', { location: 'https://store.example/us/magento_version' })

		assert.match(problem, /answered 301\./)
		assert.match(problem, /the store answers at https:\/\/store\.example\/us\/magento_version/)
		assert.match(problem, /Point the base URL at that/)
	})

	it('adds nothing to a redirect that names no address to follow', () => {
		const problem = answer(302, '', html)

		assert.equal(
			problem,
			'https://store.example/magento_version answered 302. ' +
				'The reply was text/html; charset=UTF-8 and its body is empty.',
		)
	})

	it('tells a demand for credentials from a flat refusal', () => {
		const unauthorized = answer(401, '', { 'www-authenticate': 'Basic realm="staging"' })
		assert.match(unauthorized, /asking for credentials/)
		assert.match(unauthorized, /The probe sends none\./)

		const forbidden = answer(403, '')
		assert.match(forbidden, /refused the request rather than answering it/)
		assert.doesNotMatch(forbidden, /asking for credentials/)
	})

	it('names maintenance and a gateway for a 503, and only a gateway for 502 and 504', () => {
		assert.match(answer(503, ''), /Magento answers 503 in maintenance mode/)

		for (const status of [502, 504]) {
			const problem = answer(status, '')
			assert.match(problem, /could not get an answer out of it/, String(status))
			assert.doesNotMatch(problem, /maintenance mode/, String(status))
		}
	})

	it('does not claim a gateway for a 500', () => {
		const problem = answer(500, '')

		assert.match(problem, /does not say which of the two answered/)
		assert.doesNotMatch(problem, /gateway/)
	})

	it('suggests nothing for a status it has no candidate cause for', () => {
		for (const status of [402, 418, 451]) {
			assert.equal(
				answer(status, 'no', { 'content-type': 'text/plain' }),
				`https://store.example/magento_version answered ${status}. ` +
					'The reply was text/plain and its body is not an HTML page.',
				String(status),
			)
		}
	})

	it('reads a content-type header whatever case it arrived in', () => {
		assert.match(answer(404, 'not found', { 'Content-Type': 'text/plain' }), /was text\/plain/)
	})
})
