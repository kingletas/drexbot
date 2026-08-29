import type { Capabilities } from '@harness/kernel'
import type { CheckDefinition } from '@harness/kernel'
import type { PreflightResult } from '@harness/kernel'
import { DriftRecorder } from '@harness/kernel'
import { BrowserSurface } from '../surfaces/browser.js'
import { HttpSurface } from '@harness/kernel'
import type { Target, TargetOptions } from '@harness/kernel'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAGENTO_AREAS } from './areas.js'
import { loadStore, uncapturedStore, type StoreBaseline } from './baseline.js'
import { MAGENTO_IMPACT } from './impact.js'
import { probeStorefront } from './probe.js'
import { sessionLessChecks, smokeChecks } from './checks.js'

import { journeyChecks } from './journeys.js'
import { depthChecks } from './depth.js'
import { checkoutChecks } from './checkout.js'
import { regressionChecks } from './regression.js'
import { LUMA_MESSAGES, LUMA_PROFILE } from './selectors.js'
import { WORKSPACE } from '../workspace.js'

const DEFAULT_URL = 'https://vanilla.test'

const DEFAULT_ADMIN_PATH = '/admin'

/** Only what is actually wired is declared true; the rest stay false. */
const CAPABILITIES: Capabilities = {
	browser: true,
	canProvisionCustomers: false,
	canProvisionCatalogue: false,
	canForcePaymentOutcome: false,
	hasMultiTenancy: false,
	canReadDatabase: false,
	canObserveOutboundWebhooks: false,
	canObserveOutboundEmail: false,
	isDisposable: true,
}

/**
 * A Magento 2 storefront, reached over HTTPS on its own hostname because a bare
 * loopback origin is not one browsers treat as trustworthy.
 */
export const magentoTarget = (options: TargetOptions = {}): Target => {
	const baseUrl = options.baseUrl ?? process.env['MAGENTO_URL'] ?? DEFAULT_URL
	const adminPath = process.env['MAGENTO_ADMIN_PATH'] ?? DEFAULT_ADMIN_PATH
	const http = new HttpSurface(baseUrl, 30_000)
	const recorder = options.recorder ?? new DriftRecorder()

	/** What this store is, captured by `houndbot baseline`; absent until somebody runs it. */
	const store =
		(options.store as StoreBaseline | undefined) ??
		loadStore(join(WORKSPACE.baselines, `magento--${options.environment ?? 'local'}.store.json`))

	// Started once and reused: launching Chromium per check costs more than the
	// whole suite. The promise is memoised rather than the browser, so two checks
	// asking at the same moment cannot both launch one.
	let launching: Promise<BrowserSurface> | undefined
	const browser = (): Promise<BrowserSurface> => {
		launching ??= BrowserSurface.launch({
			baseUrl,
			profile: LUMA_PROFILE,
			messages: LUMA_MESSAGES,
			recorder,
		})
		return launching
	}

	return {
		name: 'magento',
		environment: options.environment ?? 'local',
		capabilities: CAPABILITIES,

		async preflight(): Promise<PreflightResult> {
			try {
				// Magento serves its edition and minor version here without a session.
				// It is coarse -- no patch level -- but it is a real identity, and a
				// run that cannot say what it tested is not evidence about anything.
				const version = await http.get('/magento_version')

				if (version.status !== 200) {
					return {
						reachable: false,
						build: 'unknown',
						capabilities: CAPABILITIES,
						problem: `${baseUrl}/magento_version answered ${version.status}`,
					}
				}

				return {
					reachable: true,
					build: version.body.trim() || 'unknown',
					capabilities: CAPABILITIES,
				}
			} catch (cause) {
				return {
					reachable: false,
					build: 'unknown',
					capabilities: CAPABILITIES,
					problem: cause instanceof Error ? cause.message : String(cause),
				}
			}
		},

		areas: () => MAGENTO_AREAS,
		repoDir:
			process.env['MAGENTO_DIR'] ?? join(homedir(), 'Development', 'magento', 'commerce-vanilla'),
		impact: () => MAGENTO_IMPACT,
		probe: () =>
			probeStorefront(baseUrl, {
				categoryPath: store?.categoryPath ?? '/',
				searchTerm: store?.searchTerm ?? 'a',
			}),

		suites(): ReadonlyMap<string, readonly CheckDefinition[]> {
			// A suite that needs a catalogue is offered only when one is known. The
			// checks are declared either way, so the sheet still shows the areas and
			// says what is missing rather than silently losing rows.
			const catalogue = store ?? uncapturedStore(baseUrl)

			return new Map<string, readonly CheckDefinition[]>([
				['smoke', smokeChecks(http, catalogue)],
				['session-less', sessionLessChecks(http, adminPath)],
				['journey', journeyChecks(browser, catalogue)],
				['regression', regressionChecks(browser, catalogue)],
				['depth', depthChecks(browser, catalogue)],
				['checkout', checkoutChecks(browser, catalogue)],
			])
		},

		async dispose(): Promise<void> {
			// Awaited rather than tested: a browser still starting when the run ends
			// outlives the process that asked for it.
			await launching?.then(started => started.close()).catch(() => undefined)
			launching = undefined
		},
	}
}
