import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

const WRAPPER = join(import.meta.dirname, '..', '..', 'bin', 'drexbot')

const SYSTEM_MKCERT_DIR = '/usr/local/share/ca-certificates'

/** Roots the machine running the tests already has, which the wrapper reads too. */
const systemMkcertRoots = (): string[] =>
	existsSync(SYSTEM_MKCERT_DIR)
		? readdirSync(SYSTEM_MKCERT_DIR)
				.filter(name => name.startsWith('mkcert') && name.endsWith('.crt'))
				.sort()
				.map(name => join(SYSTEM_MKCERT_DIR, name))
		: []

const pem = (label: string): string =>
	`-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----`

describe('the drexbot wrapper', () => {
	let home = ''

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'drexbot-wrapper-'))
		const fakeBin = join(home, 'fake-bin')
		mkdirSync(fakeBin)
		writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nprintf "%s" "$NODE_EXTRA_CA_CERTS"\n')
		chmodSync(join(fakeBin, 'node'), 0o755)
	})

	afterEach(() => rmSync(home, { recursive: true, force: true }))

	const place = (path: string, content: string): string => {
		const full = join(home, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, content)
		return full
	}

	const run = (extra: Record<string, string> = {}): string => {
		const result = spawnSync('bash', [WRAPPER], {
			encoding: 'utf8',
			env: {
				PATH: `${join(home, 'fake-bin')}:${process.env['PATH'] ?? ''}`,
				HOME: home,
				XDG_CACHE_HOME: join(home, 'cache'),
				...extra,
			},
		})
		assert.equal(result.status, 0, result.stderr)
		return result.stdout
	}

	/** Checks what the wrapper handed Node, in its search order, with the machine's own mkcert roots added. */
	const expectRoots = (
		output: string,
		placed: { readonly mkcert?: string; readonly others?: readonly string[] },
	): void => {
		const roots = [
			...(placed.mkcert === undefined ? [] : [placed.mkcert]),
			...systemMkcertRoots(),
			...(placed.others ?? []),
		]

		if (roots.length === 0) {
			assert.equal(output, '')
		} else if (roots.length === 1) {
			assert.equal(output, roots[0])
		} else {
			assert.equal(output, join(home, 'cache', 'drexbot', 'extra-ca.pem'))
			const joined = roots.map(root => `${readFileSync(root, 'utf8')}\n`).join('')
			assert.equal(readFileSync(output, 'utf8'), joined)
		}
	}

	it('adds no root when the machine has none', () => {
		expectRoots(run(), {})
	})

	it('finds the Warden root', () => {
		const warden = place('.warden/ssl/rootca/certs/ca.cert.pem', pem('warden'))

		expectRoots(run(), { others: [warden] })
	})

	it('finds a Warden root moved by WARDEN_HOME_DIR', () => {
		const warden = place('elsewhere/ssl/rootca/certs/ca.cert.pem', pem('warden'))

		expectRoots(run({ WARDEN_HOME_DIR: join(home, 'elsewhere') }), { others: [warden] })
	})

	it('joins several roots into one file, even when one lacks its last newline', () => {
		const mkcert = place('.local/share/mkcert/rootCA.pem', `${pem('mkcert')}\n`)
		const warden = place('.warden/ssl/rootca/certs/ca.cert.pem', pem('warden'))
		const den = place('.den/ssl/rootca/certs/ca.cert.pem', pem('den'))

		const output = run()

		expectRoots(output, { mkcert, others: [warden, den] })
		assert.match(
			readFileSync(output, 'utf8'),
			/-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nden/,
		)
	})

	it('finds the mkcert root at CAROOT', () => {
		const mkcert = place('moved-caroot/rootCA.pem', pem('mkcert'))

		expectRoots(run({ CAROOT: join(home, 'moved-caroot') }), { mkcert })
	})

	it('keeps one copy of a root found in two places', () => {
		const warden = place('.warden/ssl/rootca/certs/ca.cert.pem', pem('same'))
		place('.den/ssl/rootca/certs/ca.cert.pem', pem('same'))

		expectRoots(run(), { others: [warden] })
	})

	it('falls back to the first root when the cache cannot be written', () => {
		const mkcert = place('.local/share/mkcert/rootCA.pem', pem('mkcert'))
		place('.warden/ssl/rootca/certs/ca.cert.pem', pem('warden'))
		const notADirectory = place('cache-is-a-file', '')

		assert.equal(run({ XDG_CACHE_HOME: notADirectory }), mkcert)
	})

	it('closes a cache directory other users could write to before using it', () => {
		const mkcert = place('.local/share/mkcert/rootCA.pem', pem('mkcert'))
		const warden = place('.warden/ssl/rootca/certs/ca.cert.pem', pem('warden'))
		const shared = join(home, 'cache', 'drexbot')
		mkdirSync(shared, { recursive: true })
		chmodSync(shared, 0o777)

		expectRoots(run(), { mkcert, others: [warden] })
		assert.equal(statSync(shared).mode & 0o777, 0o700)
	})

	it('leaves NODE_EXTRA_CA_CERTS alone when it is already set', () => {
		place('.warden/ssl/rootca/certs/ca.cert.pem', pem('warden'))

		assert.equal(run({ NODE_EXTRA_CA_CERTS: '/chosen/by/you.pem' }), '/chosen/by/you.pem')
	})
})
