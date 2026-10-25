import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	judge,
	kneeOf,
	nextStep,
	renderStepTest,
	type Judged,
	type StepOutcome,
	type StepPlan,
	type StepTaken,
} from '../src/swarm/step.js'
import { againstCaps, cpusFromStats, machineLoad } from '../src/swarm/store-load.js'

/** A step at `users`: by default a store that scales, ten answers a second per user, every request's p95 at 100 ms. */
const outcome = (
	users: number,
	checkoutP95: number | undefined,
	failures = 0,
	perSecond = users * 10,
	p95 = 100,
): StepOutcome => ({ users, checkoutP95, p95, requests: 1_000, failures, perSecond })

const first = judge([], outcome(10, 400))
const plan: StepPlan = { start: 10, most: 640, resolution: 0.1 }

/** A store that scales to `knee` users and answers no more after it, the way a capped store saturates. */
const store =
	(knee: number) =>
	(users: number): StepOutcome =>
		outcome(users, 400, 0, Math.min(users, knee) * 10)

const walk = (respond: (users: number) => StepOutcome): { steps: Judged[]; done: string } => {
	const steps: Judged[] = []
	for (;;) {
		const next = nextStep(steps, plan)
		if ('done' in next) return { steps, done: next.done }
		steps.push(judge(steps, respond(next.users)))
	}
}

describe('the step test judges a step', () => {
	it('calls a step good while answers rise with users, p95 holds and nothing fails', () => {
		assert.equal(judge([first], outcome(20, 600)).verdict, 'good')
	})

	it('calls it the knee when twice the users buy less than half again the answers', () => {
		const judged = judge([first], outcome(20, 400, 0, 120))
		assert.equal(judged.verdict, 'knee')
		assert.match(judged.reason, /100% more users than 10 bought 20% more answers/)
	})

	it('reads the extra answers against the nearest good step below, not the first', () => {
		const steps = [
			first,
			judge([first], outcome(20, 400)),
			{ ...outcome(40, 400, 0, 220), verdict: 'knee' as const, reason: '' },
		]
		assert.equal(judge(steps, outcome(30, 400, 0, 290)).verdict, 'good')
	})

	it("calls it the knee when every request's p95 doubles", () => {
		const judged = judge([first], outcome(20, 400, 0, 200, 200))
		assert.equal(judged.verdict, 'knee')
		assert.match(judged.reason, /p95 of every request 200 ms, 2\.0 times the first step's 100 ms/)
	})

	it('calls it the knee when checkout p95 doubles', () => {
		const judged = judge([first], outcome(20, 800))
		assert.equal(judged.verdict, 'knee')
		assert.match(judged.reason, /checkout p95 800 ms, 2\.0 times the first step's 400 ms/)
	})

	it('calls it the knee when one request in a hundred fails', () => {
		assert.equal(judge([first], outcome(20, 400, 10)).verdict, 'knee')
	})

	it('calls it the break when one in twenty fails', () => {
		assert.equal(judge([first], outcome(20, 400, 50)).verdict, 'break')
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
		// Half the extra answers is the line, so the bracket can sit a little above where the store flattened.
		assert.ok(lastGood !== undefined && lastGood.users >= 80 && lastGood.users <= 125)
		assert.ok(
			firstBad !== undefined && firstBad.users - lastGood.users <= Math.ceil(lastGood.users * 0.1),
		)
		assert.match(done, /the knee is between \d+ and \d+ users/)
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

describe('the step test as a person reads it', () => {
	const caps = (php: number, db: number) => [
		{ service: 'php', capCpus: 2, share: php },
		{ service: 'db', capCpus: 1, share: db },
	]
	const taken = (users: number, p95: number, php: number, machine = 0.3): StepTaken => ({
		...outcome(users, p95),
		verdict: p95 >= 800 ? 'knee' : 'good',
		reason: '',
		run: `run-${users}`,
		seconds: 120,
		ordersPlaced: users,
		capped: caps(php, 0.2),
		machineLoad: machine,
	})

	it('reads the knee as ratios against the caps, names what gave first, and gives no shoppers per minute', () => {
		const text = renderStepTest(
			[taken(10, 400, 0.3), taken(20, 500, 0.6), taken(40, 1_000, 0.97)],
			'the knee is between 20 and 40 users',
			{ target: 'http://shop.example', mix: 'normal-day', workers: 5 },
		)
		// 20 orders in 2 minutes is 10 a minute: 10 / 3 store CPUs, 10 / 2 PHP CPUs, 10 / 5 workers.
		assert.match(
			text,
			/at the last good step: 3\.33 orders a minute per store CPU, 5\.00 per PHP CPU, 2\.00 per PHP-FPM worker/,
		)
		assert.match(
			text,
			/gives first: php 97% of 2 CPU at the first bad step, php 60% of 2 CPU at the last good one/,
		)
		assert.match(text, /the store's caps: db 1, php 2 CPU; 5 PHP-FPM workers/)
		assert.match(text, /the knee is the store's/)
		assert.doesNotMatch(text, /shoppers? (a|per) minute/)
	})

	it('says when the machine, not the store, may be what a step measured', () => {
		const text = renderStepTest([taken(10, 400, 0.3), taken(20, 1_000, 0.5, 0.9)], 'stopped', {
			target: 'http://shop.example',
			mix: 'normal-day',
		})
		assert.match(text, /the machine passed 75% load at 20 users/)
	})
})

describe('a store without caps', () => {
	it("is never read as the store's knee", () => {
		const step = (users: number, verdict: 'good' | 'knee'): StepTaken => ({
			...outcome(users, 400),
			verdict,
			reason: '',
			run: `run-${users}`,
			seconds: 120,
			ordersPlaced: users,
			capped: [],
			machineLoad: 0.1,
		})
		const text = renderStepTest(
			[step(5, 'good'), step(6, 'knee')],
			'the knee is between 5 and 6 users',
			{
				target: 'http://shop.example',
				mix: 'normal-day',
			},
		)
		assert.doesNotMatch(text, /the knee is the store's/)
		assert.doesNotMatch(text, /per store CPU/)
		assert.match(
			text,
			/no service had a CPU cap, so this is a count of users for this store alone, not a ratio/,
		)
	})
})
