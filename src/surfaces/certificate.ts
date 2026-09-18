import { PreconditionFailure } from 'harness-kernel'

const LOCAL_SUFFIXES = ['.test', '.localhost', '.local']

const LOCAL_HOSTS = new Set(['localhost', '[::1]'])

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** A development store, where a locally issued certificate is expected rather than a defect. */
export const isLocalStore = (baseUrl: string): boolean => {
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

// Chromium's own names, and the ones a retry cannot change: a certificate it will not
// accept, transparency it demands, or a client certificate this machine does not hold.
const CERTIFICATE_ERROR =
	/net::(ERR_CERT_[A-Z_]+|ERR_CERTIFICATE_TRANSPARENCY_REQUIRED|ERR_BAD_SSL_CLIENT_AUTH_CERT)/

const TRUST_THE_ROOT =
	"Chromium keeps its own list of trusted certificates and never reads NODE_EXTRA_CA_CERTS, so a root that works for the harness's own requests does nothing here. " +
	'On Linux, import it into the database Chromium reads (the folder has to exist first): ' +
	'`mkdir -p ~/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n drexbot-local-ca -i /path/to/rootCA.pem`. ' +
	"On macOS and Windows, add it to the system's own trusted roots. " +
	'(`mkcert -install` does either for you; Warden and Den do not always.)'

const CHAIN_IS_WRONG =
	'The chain this store serves does not reach a root Chromium trusts. Check that it sends its intermediate certificate, ' +
	"and if a proxy that inspects TLS sits in the way, import that proxy's root into Chromium's own list."

const REASONS: Readonly<Record<string, string>> = {
	ERR_CERT_COMMON_NAME_INVALID:
		'The certificate this store serves does not cover the hostname it was asked for.',
	ERR_CERT_DATE_INVALID: 'The certificate this store serves has expired, or is not valid yet.',
	ERR_CERT_REVOKED: 'The certificate this store serves has been revoked.',
	ERR_CERTIFICATE_TRANSPARENCY_REQUIRED:
		'Chromium requires this certificate to be published to a certificate transparency log, and it is not.',
	ERR_BAD_SSL_CLIENT_AUTH_CERT:
		'This store asked for a client certificate, and the browser has none to offer.',
}

/**
 * Turns a certificate Chromium refused into a precondition naming the fix, since no
 * retry makes an untrusted certificate work; every other navigation error is returned as it is.
 */
export const navigationFailure = (error: unknown, baseUrl: string): unknown => {
	if (!(error instanceof Error)) return error
	// Its own message still carries the code, so a second pass would wrap the advice twice.
	if (error instanceof PreconditionFailure) return error

	const code = CERTIFICATE_ERROR.exec(error.message)?.[1]
	if (code === undefined) return error

	const named = REASONS[code]
	const advice =
		named ??
		(code === 'ERR_CERT_AUTHORITY_INVALID'
			? isLocalStore(baseUrl)
				? TRUST_THE_ROOT
				: CHAIN_IS_WRONG
			: `Chromium refused this store's certificate (${code}).`)

	return new PreconditionFailure(`${error.message.split('\n')[0]} — ${advice}`, { cause: error })
}
