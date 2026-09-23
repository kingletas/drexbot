// The protocol bee: k6 users asking for the store's pages over HTTP, writing the same `bee/1` lines as the browser bee.
// k6 users share no state, so each histogram bucket is a k6 counter that k6 adds up across users.
import http from 'k6/http'
import { Counter } from 'k6/metrics'

// These three repeat src/bee/histogram.ts, which k6 cannot import; a unit test holds them equal.
const FIRST_BOUND_MS = 1
const GROWTH = 1.25
const BUCKETS = 50

// Codes a store answers often get their own counter; anything else is counted as `other`.
const STATUSES = [
	'200',
	'301',
	'302',
	'304',
	'400',
	'403',
	'404',
	'429',
	'500',
	'502',
	'503',
	'504',
]

const base = __ENV.BEE_URL.endsWith('/') ? __ENV.BEE_URL : `${__ENV.BEE_URL}/`
const paths = JSON.parse(__ENV.BEE_PATHS)
const users = Math.floor(Number(__ENV.BEE_CONCURRENCY))
const seconds = Math.floor(Number(__ENV.BEE_SECONDS))

const bucketOf = ms => {
	if (!(ms > FIRST_BOUND_MS)) return 0
	return Math.min(Math.ceil(Math.log(ms / FIRST_BOUND_MS) / Math.log(GROWTH)), BUCKETS - 1)
}

const range = n => Array.from({ length: n }, (_, i) => i)

const counters = paths.map((_, s) => ({
	count: new Counter(`s${s}_count`),
	failures: new Counter(`s${s}_failures`),
	ttfb: range(BUCKETS).map(b => new Counter(`s${s}_ttfb_${b}`)),
	total: range(BUCKETS).map(b => new Counter(`s${s}_total_${b}`)),
	statuses: Object.fromEntries(
		[...STATUSES, 'other', 'error'].map(code => [code, new Counter(`s${s}_status_${code}`)]),
	),
}))

export const options = {
	scenarios: {
		bee: { executor: 'constant-vus', vus: users, duration: `${seconds}s`, gracefulStop: '5s' },
	},
	discardResponseBodies: true,
	summaryTrendStats: ['avg'],
}

export default function () {
	const s = (__VU + __ITER) % paths.length
	const response = http.get(base + paths[s].path.replace(/^\//, ''), {
		tags: { stage: paths[s].stage },
	})
	const c = counters[s]
	c.count.add(1)
	if (response.status < 200 || response.status >= 400) c.failures.add(1)
	const code = response.status === 0 ? 'error' : String(response.status)
	c.statuses[STATUSES.includes(code) || code === 'error' ? code : 'other'].add(1)
	if (response.status !== 0) {
		c.ttfb[bucketOf(response.timings.waiting)].add(1)
		c.total[bucketOf(response.timings.duration)].add(1)
	}
}

const countIn = (data, name) => data.metrics[name]?.values?.count ?? 0

const sparse = (data, prefix) =>
	Object.fromEntries(
		range(BUCKETS)
			.map(b => [String(b), countIn(data, `${prefix}_${b}`)])
			.filter(([, count]) => count > 0),
	)

// k6 prints the lines here, at the end, because a virtual user cannot see the others' counts.
export function handleSummary(data) {
	const identity = { drexbot: 'bee/1', run: __ENV.BEE_RUN, bee: __ENV.BEE_ID, kind: 'protocol' }
	const now = new Date()
	const started = new Date(now.getTime() - data.state.testRunDurationMs)
	const lines = [{ ...identity, event: 'started', at: started.toISOString(), concurrency: users }]
	paths.forEach((path, s) => {
		const statuses = Object.fromEntries(
			[...STATUSES, 'other', 'error']
				.map(code => [code, countIn(data, `s${s}_status_${code}`)])
				.filter(([, count]) => count > 0),
		)
		lines.push({
			...identity,
			event: 'window',
			at: now.toISOString(),
			stage: path.stage,
			count: countIn(data, `s${s}_count`),
			failures: countIn(data, `s${s}_failures`),
			statuses,
			ttfb: sparse(data, `s${s}_ttfb`),
			total: sparse(data, `s${s}_total`),
		})
	})
	lines.push({ ...identity, event: 'finished', at: now.toISOString(), concurrency: users })
	return { stdout: `${lines.map(line => JSON.stringify(line)).join('\n')}\n` }
}
