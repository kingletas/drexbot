import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { magentoTarget } from '../src/magento/adapter.js'
import { describeUnreachable } from '../src/magento/unreachable.js'

const listen = (server: Server): Promise<number> =>
	new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
	})

const close = (server: Server): Promise<void> =>
	new Promise(resolve => server.close(() => resolve()))

const problemAt = async (baseUrl: string): Promise<string> => {
	const preflight = await magentoTarget({ baseUrl, environment: 'stub', store: {} }).preflight()
	assert.equal(preflight.reachable, false)
	return preflight.problem ?? ''
}

/** A certificate made for this run only, so no private key is ever committed. */
const selfSignedCertificate = (): { key: Buffer; cert: Buffer } => {
	const directory = mkdtempSync(join(tmpdir(), 'drexbot-tls-'))
	try {
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=localhost',
				'-keyout',
				join(directory, 'key.pem'),
				'-out',
				join(directory, 'cert.pem'),
			],
			{ stdio: 'ignore' },
		)
		return {
			key: readFileSync(join(directory, 'key.pem')),
			cert: readFileSync(join(directory, 'cert.pem')),
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe('preflight against a store Node cannot reach', () => {
	const store = createHttpsServer(selfSignedCertificate(), (_request, response) => {
		response.end('Magento/2.4 (Community)')
	})
	let port = 0

	before(async () => {
		port = await listen(store)
	})

	after(() => close(store))

	it('names the certificate error and the variable that fixes it', async () => {
		const problem = await problemAt(`https://localhost:${port}`)

		assert.match(problem, /fetch failed \(DEPTH_ZERO_SELF_SIGNED_CERT: /)
		assert.match(problem, /set NODE_EXTRA_CA_CERTS to the root certificate/)
	})

	it('names a refused connection without suggesting a certificate', async () => {
		const stopped = createHttpServer()
		const stoppedPort = await listen(stopped)
		await close(stopped)

		const problem = await problemAt(`http://127.0.0.1:${stoppedPort}`)

		assert.match(problem, /fetch failed \(ECONNREFUSED: /)
		assert.doesNotMatch(problem, /NODE_EXTRA_CA_CERTS/)
	})
})

describe('describeUnreachable', () => {
	const fetchFailure = (code: string): Error =>
		new Error('GET https://store.test/magento_version: fetch failed', {
			cause: new TypeError('fetch failed', {
				cause: Object.assign(new Error('certificate problem'), { code }),
			}),
		})

	it('suggests a root for every code that trusting a root fixes', () => {
		for (const code of [
			'SELF_SIGNED_CERT_IN_CHAIN',
			'UNABLE_TO_GET_ISSUER_CERT',
			'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		]) {
			assert.match(describeUnreachable(fetchFailure(code)), /NODE_EXTRA_CA_CERTS/, code)
		}
	})

	it('suggests nothing when trusting a root would not help', () => {
		for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND']) {
			assert.equal(
				describeUnreachable(fetchFailure(code)),
				'GET https://store.test/magento_version: fetch failed',
				code,
			)
		}
	})

	it('survives a cause chain that loops back on itself', () => {
		const looped = new Error('fetch failed')
		looped.cause = looped

		assert.equal(describeUnreachable(looped), 'fetch failed')
	})
})
