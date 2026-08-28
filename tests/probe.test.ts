import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startStorefrontStub } from '../fixtures/storefront-stub.js'
import { probeSummary, renderProbe, type ProbeReport } from '@harness/kernel'
import { probeStorefront } from '../src/magento/probe.js'

const report = (findings: ProbeReport['findings']): ProbeReport => ({
	target: 'magento',
	baseUrl: 'https://example.test',
	findings,
	unreached: [],
})

const finding = (entry: string, resolved: boolean, index: number, of: number) => ({
	stage: 'home',
	entry,
	resolved,
	via: resolved ? 'a-selector' : 'NO MATCH',
	...(resolved ? { index } : {}),
	of,
	matches: resolved ? 1 : 0,
})

describe('probeSummary', () => {
	it('counts what resolved', () => {
		const summary = probeSummary(report([finding('a', true, 0, 3), finding('b', false, 0, 3)]))

		assert.equal(summary.resolved, 1)
		assert.equal(summary.total, 2)
	})

	it('counts entries answering on their last candidate separately', () => {
		// The interesting middle case: it works today and is one theme change from
		// not. A count of what resolved cannot say that on its own.
		const summary = probeSummary(report([finding('a', true, 2, 3), finding('b', true, 0, 3)]))

		assert.equal(summary.resolved, 2)
		assert.equal(summary.falling, 1)
	})
})

describe('renderProbe', () => {
	const render = (probe: ProbeReport): string => {
		const lines: string[] = []
		renderProbe(probe, line => lines.push(line))
		return lines.join('\n')
	}

	it('shows which candidate answered, and where in the list it sits', () => {
		assert.match(
			render(report([finding('searchInput', true, 1, 3)])),
			/searchInput\s+a-selector\s+\[2 of 3\]/,
		)
	})

	it('says NO MATCH rather than leaving a blank', () => {
		assert.match(render(report([finding('addToCart', false, 0, 3)])), /✗ addToCart\s+NO MATCH/)
	})

	it('warns when something resolved only on its last candidate', () => {
		assert.match(render(report([finding('a', true, 2, 3)])), /portable today, not tomorrow/)
	})

	it('names a stage it could not reach at all', () => {
		const probe: ProbeReport = {
			...report([]),
			unreached: [{ stage: 'product', why: 'timed out' }],
		}

		assert.match(render(probe), /product\s+— not reached: timed out/)
	})
})

describe('probing a storefront the suite cannot drive', () => {
	it('reports every entry as unresolved rather than throwing', async () => {
		// The answer "this suite cannot drive that site" is a finding, not a
		// failure. A probe that threw would be a gate, and a gate is not the thing
		// you run first.
		const stub = await startStorefrontStub()
		try {
			const probe = await probeStorefront(stub.url, {
				categoryPath: '/women/tops-women.html',
				searchTerm: 'bag',
				timeoutMs: 200,
			})

			assert.ok(probe.findings.length > 0)
			assert.ok(probe.findings.some(item => !item.resolved))
			assert.ok(probe.findings.every(item => item.stage.length > 0))
		} finally {
			await stub.close()
		}
	})
})
