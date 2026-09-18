/** What a status other than 200 needs to be explained, beyond the status itself. */
export interface UnexpectedStatusContext {
	readonly baseUrl: string
	/** The path that was asked for, so the message names the address that answered. */
	readonly path: string
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

/** Markup a rendered page carries and a plain-text answer does not. */
const HTML_MARKUP = /<(!doctype\s+html|html|head|body|title)[\s>/]/i

/** Markup only Magento renders: its no-route body class, and its versioned static path. */
const MAGENTO_MARKUP = /cms-noroute-index|\/static\/version\d+\//

const headerOf = (headers: Readonly<Record<string, string>>, name: string): string | undefined =>
	Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]

/** What came back, in the terms that tell a proxy's error page from Magento's own. */
const describeBody = (contentType: string | undefined, body: string): string => {
	const type =
		contentType === undefined || contentType === ''
			? 'The reply named no content type'
			: `The reply was ${contentType}`

	if (body.trim() === '') return `${type} and its body is empty.`

	return HTML_MARKUP.test(body)
		? `${type} and its body looks like an HTML error page.`
		: `${type} and its body is not an HTML page.`
}

const MAGENTO_ANSWERED =
	'The body carries Magento markup, so the store itself answered and does not serve this route. ' +
	'A headless or route-narrowed storefront does that, and so does a base URL missing the ' +
	'store-code prefix the route sits behind.'

const SOMETHING_ELSE_ANSWERED =
	'An HTML error page here is one that something in front of the store can produce: a cache or ' +
	'proxy answering before Magento sees the path, or a front end that is not this store at all. ' +
	'Check what terminates TLS for this hostname, and whether the base URL needs a store-code prefix.'

const CREDENTIALS_DEMANDED =
	'Something in front of the store is asking for credentials, which a staging site behind HTTP ' +
	'basic authentication does. The probe sends none.'

const REFUSED =
	'Something refused the request rather than answering it, which an address allowlist or a web ' +
	'application firewall does. Check whether this machine is allowed to reach the store.'

const UNAVAILABLE =
	'Magento answers 503 in maintenance mode, and a cache or proxy answers it when the store behind ' +
	'it did not reply. Check for a maintenance flag, and whether the store answers to whatever sits ' +
	'in front of it.'

const GATEWAY_FAILED =
	'A gateway status means something is in front of the store and could not get an answer out of ' +
	'it. Check that the store is running and that the gateway is pointed at it.'

const STORE_FAILED =
	"The store or something in front of it failed on this request, and Magento's own exception log " +
	'is where the cause is. The status alone does not say which of the two answered.'

/** A 404 is only worth attributing when the body says who wrote it. */
const notFound = (body: string): string | undefined => {
	if (!HTML_MARKUP.test(body)) return undefined
	return MAGENTO_MARKUP.test(body) ? MAGENTO_ANSWERED : SOMETHING_ELSE_ANSWERED
}

/** Redirects are requested manually, so the address to follow is a fact rather than a guess. */
const redirected = (location: string | undefined): string | undefined =>
	location === undefined || location === ''
		? undefined
		: 'Redirects are not followed here, so this is the address saying the store answers at ' +
			`${location}. Point the base URL at that and run again.`

const causeOf = (context: UnexpectedStatusContext): string | undefined => {
	const { status } = context
	if (status >= 300 && status < 400) return redirected(headerOf(context.headers, 'location'))
	if (status === 401) return CREDENTIALS_DEMANDED
	if (status === 403) return REFUSED
	if (status === 404) return notFound(context.body)
	if (status === 500) return STORE_FAILED
	if (status === 502 || status === 504) return GATEWAY_FAILED
	if (status === 503) return UNAVAILABLE
	return undefined
}

/**
 * Why the store answered something other than 200, naming a candidate cause only when
 * the answer carries something to name it from.
 */
export const describeUnexpectedStatus = (context: UnexpectedStatusContext): string => {
	const answered = `${context.baseUrl}${context.path} answered ${context.status}`
	const body = describeBody(headerOf(context.headers, 'content-type'), context.body)
	const cause = causeOf(context)

	return cause === undefined ? `${answered}. ${body}` : `${answered}. ${body} ${cause}`
}
