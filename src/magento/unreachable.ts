/** What the hint needs to know besides the error itself. */
export interface UnreachableContext {
	readonly baseUrl: string
	/** The value of `NODE_EXTRA_CA_CERTS` this process started with, if any. */
	readonly extraCaCerts: string | undefined
}

/** Certificate errors that trusting the issuing root fixes, as Node's TLS layer names them. */
const UNTRUSTED_ROOT_CODES = new Set([
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** On a public store these usually mean the server leaves out its intermediate certificate. */
const MISSING_INTERMEDIATE_CODES = new Set([
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const LOCAL_SUFFIXES = ['.test', '.localhost', '.local']

const LOCAL_HOSTS = new Set(['localhost', '[::1]'])

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** A development store, where a local root is the expected issuer rather than a defect. */
const isLocal = (baseUrl: string): boolean => {
	let hostname: string
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '')
	} catch {
		return false
	}
	return (
		LOCAL_HOSTS.has(hostname) ||
		LOOPBACK_V4.test(hostname) ||
		LOCAL_SUFFIXES.some(suffix => hostname.endsWith(suffix))
	)
}

const codesOf = (error: unknown): string[] => {
	const codes: string[] = []
	const seen = new Set<unknown>()
	let current = error
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current)
		const code: unknown = (current as { code?: unknown }).code
		if (typeof code === 'string') codes.push(code)
		current = current.cause
	}
	return codes
}

const localHint = (extraCaCerts: string | undefined): string =>
	extraCaCerts === undefined || extraCaCerts === ''
		? 'Node ignores the certificates this machine trusts, so set NODE_EXTRA_CA_CERTS to the ' +
			"root certificate that issued this store's certificate (a self-signed certificate is " +
			'its own root) and run again.'
		: `NODE_EXTRA_CA_CERTS is set to ${extraCaCerts}, but it does not give Node the root ` +
			"that issued this store's certificate. Point it at that root and run again."

const PROXY_HINT =
	'If this machine reaches the store through a proxy that inspects TLS, set ' +
	"NODE_EXTRA_CA_CERTS to that proxy's root certificate."

const MISSING_INTERMEDIATE_HINT =
	'The store may not be sending its intermediate certificate. Browsers often fetch a missing ' +
	'one for themselves and most other clients do not, so check the chain the store serves. ' +
	PROXY_HINT

/** Why the store could not be reached, with the fix named when it is one we know. */
export const describeUnreachable = (error: unknown, context: UnreachableContext): string => {
	const message = error instanceof Error ? error.message : String(error)
	const codes = codesOf(error)

	if (isLocal(context.baseUrl)) {
		return codes.some(code => UNTRUSTED_ROOT_CODES.has(code))
			? `${message}. ${localHint(context.extraCaCerts)}`
			: message
	}

	if (codes.some(code => MISSING_INTERMEDIATE_CODES.has(code))) {
		return `${message}. ${MISSING_INTERMEDIATE_HINT}`
	}
	return codes.includes('SELF_SIGNED_CERT_IN_CHAIN') ? `${message}. ${PROXY_HINT}` : message
}
