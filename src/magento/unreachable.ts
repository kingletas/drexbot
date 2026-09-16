/** Certificate errors that trusting the issuing root fixes, as Node's TLS layer names them. */
const UNTRUSTED_ROOT_CODES = new Set([
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const UNTRUSTED_ROOT_HINT =
	'Node ignores the certificates this machine trusts, so set NODE_EXTRA_CA_CERTS to the ' +
	"root certificate that issued this store's certificate (a self-signed certificate is " +
	'its own root) and run again.'

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

/** Why the store could not be reached, with the fix named when it is one we know. */
export const describeUnreachable = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error)
	const untrustedRoot = codesOf(error).some(code => UNTRUSTED_ROOT_CODES.has(code))

	return untrustedRoot ? `${message}. ${UNTRUSTED_ROOT_HINT}` : message
}
