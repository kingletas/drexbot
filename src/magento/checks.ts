import type { CheckDefinition } from 'harness-kernel'
import { AssertionFailure, PreconditionFailure } from 'harness-kernel'
import type { HttpSurface } from 'harness-kernel'
import { NO_BASELINE, type StoreBaseline } from './baseline.js'
import { MUST_NOT_SERVE, REST_PROBES, storefrontPages } from './surfaces.js'

/**
 * The storefront pages a shopper cannot do without, each asserting a body
 * marker as well as a status because Magento answers 200 with an error page.
 */
export const smokeChecks = (
	http: HttpSurface,
	store: StoreBaseline,
): readonly CheckDefinition[] => [
	...storefrontPages(store).map((page): CheckDefinition => ({
		id: `magento.smoke.${page.id}`,
		title: page.title,
		suite: 'smoke',
		area: page.area,
		async body({ measure, record }) {
			// A page whose path is a fact about this store cannot be asked for
			// until that fact is known.
			if (page.needsCatalogue === true && !store.captured) {
				throw new PreconditionFailure(NO_BASELINE)
			}

			const response = await http.get(page.path)
			measure({ name: 'response', value: response.durationMs, unit: 'ms', stage: page.path })
			record('cache', response.headers['x-cache'] ?? 'not reported')

			if (response.status !== 200) {
				throw new AssertionFailure(`${page.path} answered ${response.status}, expected 200`)
			}
			if (!response.body.includes(page.mustContain)) {
				throw new AssertionFailure(
					`${page.path} answered 200 but the body does not contain "${page.mustContain}"`,
				)
			}
		},
	})),
	{
		id: 'magento.smoke.graphql',
		title: 'GraphQL answers a store configuration query',
		suite: 'smoke',
		area: 'graphql',
		async body({ measure, record }) {
			const response = await http.send({
				method: 'POST',
				path: '/graphql',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query: '{storeConfig{store_code}}' }),
			})
			measure({ name: 'response', value: response.durationMs, unit: 'ms', stage: '/graphql' })

			if (response.status !== 200) {
				throw new AssertionFailure(`/graphql answered ${response.status}, expected 200`)
			}

			const payload = JSON.parse(response.body) as {
				data?: { storeConfig?: { store_code?: string } }
				errors?: unknown[]
			}
			if (payload.errors !== undefined) {
				throw new AssertionFailure(
					`/graphql answered 200 with errors: ${JSON.stringify(payload.errors).slice(0, 200)}`,
				)
			}
			record('store code', payload.data?.storeConfig?.store_code ?? 'absent')
		},
	},
]

/**
 * What the store gives a caller carrying nothing at all; the admin check reads
 * the body, because the login page and the dashboard both answer 200.
 */
export const sessionLessChecks = (
	http: HttpSurface,
	adminPath: string,
): readonly CheckDefinition[] => [
	{
		id: 'magento.session-less.admin-is-a-login-form',
		title: 'The admin answers with a login form, never a dashboard',
		suite: 'session-less',
		area: 'admin',
		async body({ record }) {
			const response = await http.get(adminPath)
			record('path', adminPath)

			if (response.status !== 200) {
				throw new AssertionFailure(
					`${adminPath} answered ${response.status}, expected the login page`,
				)
			}

			const body = response.body.toLowerCase()
			// A login form carries a form key and the sign-in prompt; a dashboard
			// carries the menu. Asserting both directions matters, because a page
			// can carry the word "login" while being something else entirely.
			if (!body.includes('form_key') || !body.includes('sign in')) {
				throw new AssertionFailure(`${adminPath} answered 200 but does not look like a login form`)
			}
			if (
				body.includes('menu-magento-backend-dashboard') ||
				body.includes('dashboard-advanced-reports')
			) {
				throw new AssertionFailure(
					`${adminPath} served admin dashboard markup to a caller with no session`,
				)
			}
		},
	},
	{
		id: 'magento.session-less.admin-deep-link',
		title: 'A deep admin URL does not bypass the login',
		suite: 'session-less',
		area: 'admin',
		async body() {
			const response = await http.get(`${adminPath}/admin/dashboard/`)
			const body = response.body.toLowerCase()

			if (response.status === 200 && !body.includes('form_key')) {
				throw new AssertionFailure(
					`${adminPath}/admin/dashboard/ answered 200 without a login form`,
				)
			}
			if (![200, 301, 302].includes(response.status)) {
				throw new AssertionFailure(
					`${adminPath}/admin/dashboard/ answered ${response.status}, expected the login page or a redirect to it`,
				)
			}
		},
	},
	...REST_PROBES.map((probe): CheckDefinition => ({
		id: `magento.session-less.rest.${probe.path.split('/').filter(Boolean).slice(-2).join('-')}`,
		title: `${probe.path} — ${probe.why}`,
		suite: 'session-less',
		area: 'rest-api',
		async body({ record }) {
			const response = await http.get(probe.path)

			if (response.status !== probe.expect) {
				record('why it matters', probe.why)
				record('body', response.body.slice(0, 300))
				throw new AssertionFailure(
					`${probe.path} answered ${response.status}, expected ${probe.expect}`,
					{ expected: probe.expect, actual: response.status },
				)
			}
		},
	})),
	...MUST_NOT_SERVE.map((file): CheckDefinition => ({
		id: `magento.session-less.not-served.${file.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
		title: `${file.path} is not served — it would leak ${file.why}`,
		suite: 'session-less',
		area: 'exposure',
		async body({ record }) {
			const response = await http.get(file.path)

			// 403 is as good as 404 here: both refuse. What must not happen is a
			// 200, and what must not happen quietly is a 200 with an empty body,
			// which still proves the path is routed.
			if (response.status === 404 || response.status === 403) return

			record('leaks', file.why)
			record('body', response.body.slice(0, 200))
			throw new AssertionFailure(
				`${file.path} answered ${response.status} — it would leak ${file.why}`,
			)
		},
	})),
]
