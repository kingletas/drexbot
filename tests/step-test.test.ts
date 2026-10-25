import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	judge,
	kneeOf,
	nextStep,
	type Judged,
	type StepOutcome,
	type StepPlan,
} from '../src/swarm/step.js'
import { againstCaps, cpusFromStats, machineLoad } from '../src/swarm/store-load.js'

const outcome = (users: number, checkoutP95: number | undefined, failures = 0): StepOutcome => ({
	users,
	checkoutP95,
	requests: 1_000,
	failures,
})

const first = outcome(10, 400)
const plan: StepPlan = { start: 10, most: 640, resolution: 0.1 }

/** A store whose knee sits at `knee` users: p95 holds until then and triples after. */
const store =
	(knee: number) =>
	(users: number): StepOutcome =>
		outcome(users, users <= knee ? 400 : 1_200)

const walk = (respond: (users: number) => StepOutcome): { steps: Judged[]; done: string } => {
	const steps: Judged[] = []
	for (;;) {
		const next = nextStep(steps, plan)
		if ('done' in next) return { steps, done: next.done }
		steps.push(judge(first, respond(next.users)))
	}
}

describe('the step test judges a step', () => {
	it('calls a step good while p95 holds and nothing fails', () => {
		assert.equal(judge(first, outcome(40, 600)).verdict, 'good')
	})

	it('calls it the knee when checkout p95 doubles', () => {
		const judged = judge(first, outcome(80, 800))
		assert.equal(judged.verdict, 'knee')
		assert.match(judged.reason, /2\.0 times the first step's 400 ms/)
	})

	it('calls it the knee when one request in a hundred fails', () => {
		assert.equal(judge(first, outcome(80, 400, 10)).verdict, 'knee')
	})

	it('calls it the break when one in twenty fails', () => {
		assert.equal(judge(first, outcome(80, 400, 50)).verdict, 'break')
	})
})

describe('the step test walks to the knee', () => {
	it('doubles to bracket the knee, then narrows it, and never runs past the first bad step by more than one doubling', () => {
		const { steps, done } = walk(store(100))
		assert.deepEqual(
			steps.slice(0, 5).map(step => step.users),
			[10, 20, 40, 80, 160],
		)
		assert.ok(steps.every(step => step.users <= 160))
		const { lastGood, firstBad } = kneeOf(steps)
		assert.equal(lastGood?.users, 100)
		assert.ok(firstBad !== undefined && firstBad.users - 100 <= 10)
		assert.match(done, /the knee is between 100 and \d+ users/)
	})

	it('stops at once on a break, with steps left to try', () => {
		const { steps, done } = walk(users =>
			users >= 40 ? outcome(users, 400, 60) : outcome(users, 400),
		)
		assert.deepEqual(
			steps.map(step => step.users),
			[10, 20, 40],
		)
		assert.match(done, /stopped at 40 users: 6\.0% of requests failed/)
	})

	it('says so when the first step is already past the knee', () => {
		const { done } = walk(users => outcome(users, 400, 20))
		assert.match(done, /the first step, 10 users, was already past the knee/)
	})

	it('gives up without a knee at the most it may send', () => {
		const { steps, done } = walk(store(10_000))
		assert.equal(steps.at(-1)?.users, 640)
		assert.equal(done, 'no knee up to 640 users')
	})
})

describe('the store against its caps', () => {
	it('reads docker stats as CPUs in use', () => {
		const used = cpusFromStats(
			'{"Name":"shop-php-1","CPUPerc":"187.50%"}\n{"Name":"shop-db-1","CPUPerc":"40.00%"}\n',
		)
		assert.equal(used.get('shop-php-1'), 1.875)
		assert.equal(used.get('shop-db-1'), 0.4)
	})

	it('names the service nearest its cap first, and leaves uncapped ones out', () => {
		const ranked = againstCaps({
			services: [
				{ service: 'db', capCpus: 1, samples: [0.3, 0.5] },
				{ service: 'php', capCpus: 2, samples: [1.8, 2] },
				{ service: 'mailpit', capCpus: undefined, samples: [0.1] },
			],
			machine: [0.2, 0.4],
		})
		assert.deepEqual(
			ranked.map(r => [r.service, Math.round(r.share * 100)]),
			[
				['php', 95],
				['db', 40],
			],
		)
	})

	it('averages the machine load', () => {
		assert.equal(Math.round(machineLoad({ services: [], machine: [0.2, 0.4] }) * 100), 30)
	})
})
