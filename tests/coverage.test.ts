import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { coverageProblems } from 'harness-kernel'
import { magentoTarget } from '../src/magento/adapter.js'

/**
 * The sheet and the checks are kept in step by this and only this; nothing else
 * notices a sheet that still renders and quietly reports less than it did.
 */
describe('magento agrees with its own sign-off sheet', () => {
	it('has no area without checks, and no check without a declared area', () => {
		const target = magentoTarget({})
		const checks = [...target.suites().values()].flat()
		const problems = coverageProblems(target.areas(), checks)

		assert.deepEqual(
			problems.map(problem => `${problem.subject} ${problem.detail}`),
			[],
		)
	})
})
