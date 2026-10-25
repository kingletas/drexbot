import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { kneeOf, type StepTaken } from './step.js'

/**
 * The knee a step test found, kept on disk so a later run can be set as a
 * fraction of it. A run reads the latest knee for its store and mix; the
 * fraction is taken of the last good step, because the step after it already
 * asked the store for more than it could answer.
 */

export const KNEE_TAG = 'swarm-knee/1'

export interface KneeRecord {
	readonly drexbot: typeof KNEE_TAG
	/** The step test's id: when it started, as the runs' ids are. */
	readonly id: string
	readonly at: string
	readonly target: string
	readonly mix: string
	/** Seconds of load in each step. */
	readonly seconds: number
	readonly lastGood: { readonly users: number; readonly run: string }
	readonly firstBad?: { readonly users: number; readonly run: string }
	/** How the test ended, as it printed it. */
	readonly done: string
	readonly caps: readonly { readonly service: string; readonly capCpus: number }[]
}

/** What a run was set from: the fraction, and enough of the knee to find it and judge it. */
export interface KneeShare {
	readonly fraction: number
	readonly knee: string
	readonly measuredAt: string
	readonly lastGood: number
	readonly caps: KneeRecord['caps']
}

/** Beside the run records, in a folder of its own, so reading the runs never meets a knee. */
export const kneeDirectory = (results: string): string => join(results, 'swarm', 'knee')

/** The knee the steps found, or undefined when no step was good. */
export const kneeRecordOf = (
	steps: readonly StepTaken[],
	done: string,
	run: { readonly id: string; readonly target: string; readonly mix: string },
): KneeRecord | undefined => {
	const { lastGood, firstBad } = kneeOf(steps)
	if (lastGood === undefined) return undefined
	return {
		drexbot: KNEE_TAG,
		id: run.id,
		at: new Date().toISOString(),
		target: run.target,
		mix: run.mix,
		seconds: lastGood.seconds,
		lastGood: { users: lastGood.users, run: lastGood.run },
		...(firstBad === undefined ? {} : { firstBad: { users: firstBad.users, run: firstBad.run } }),
		done,
		caps: lastGood.capped.map(cap => ({ service: cap.service, capCpus: cap.capCpus })),
	}
}

export const writeKnee = (results: string, knee: KneeRecord): string => {
	const directory = kneeDirectory(results)
	mkdirSync(directory, { recursive: true })
	const path = join(directory, `${knee.id}.json`)
	writeFileSync(path, `${JSON.stringify(knee, null, '\t')}\n`)
	return path
}

/** The newest knee measured for this store at this mix, or undefined when none was. */
export const latestKnee = (
	results: string,
	target: string,
	mix: string,
): KneeRecord | undefined => {
	const directory = kneeDirectory(results)
	if (!existsSync(directory)) return undefined
	return readdirSync(directory)
		.filter(name => name.endsWith('.json'))
		.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as KneeRecord)
		.filter(knee => knee.drexbot === KNEE_TAG && knee.target === target && knee.mix === mix)
		.sort((a, b) => a.at.localeCompare(b.at))
		.at(-1)
}

/** Users spread over as few bees as hold them, each bee's share rounded down so the whole stays under `users`. */
export const spread = (users: number, perBee: number): { bees: number; each: number } => {
	const bees = Math.ceil(users / Math.max(1, perBee))
	return { bees, each: Math.floor(users / bees) }
}

/**
 * The users a run gets at `fraction` of the knee, rounded down, or why it
 * gets none. Rounding down keeps a run under the share it asked for.
 */
export const usersAt = (knee: KneeRecord, fraction: number): number | string => {
	if (!(fraction > 0 && fraction <= 1))
		return `--of-knee is a fraction of the knee, above 0 and at most 1, not ${fraction}`
	const users = Math.floor(knee.lastGood.users * fraction)
	if (users < 1)
		return (
			`${fraction} of the knee's last good step, ${knee.lastGood.users} users, is under one user; ` +
			'choose a larger fraction, or measure the knee again if the store has grown'
		)
	return users
}

export const shareOf = (knee: KneeRecord, fraction: number): KneeShare => ({
	fraction,
	knee: knee.id,
	measuredAt: knee.at,
	lastGood: knee.lastGood.users,
	caps: knee.caps,
})

/** One line for the run's printout: the fraction, and which knee it is a fraction of. */
export const renderShare = (share: KneeShare): string =>
	`  load: ${share.fraction} of the knee measured ${share.measuredAt.slice(0, 16).replace('T', ' ')} UTC ` +
	`(step test ${share.knee}, last good step ${share.lastGood} users, caps ` +
	`${[...share.caps]
		.sort((a, b) => a.service.localeCompare(b.service))
		.map(cap => `${cap.service} ${cap.capCpus}`)
		.join(', ')} CPU)`
