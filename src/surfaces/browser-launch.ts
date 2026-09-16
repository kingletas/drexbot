import { chromium, type Browser } from 'playwright'
import { PreconditionFailure, TransportFailure } from 'harness-kernel'

const MISSING_LIBRARY = /error while loading shared libraries: ([^:\s]+)/

const MISSING_DEPENDENCIES = /Host system is missing dependencies/

const NOT_INSTALLED = /Executable doesn't exist at (\S+)/

/**
 * Names a setup problem as a precondition, which is never retried and has one fix,
 * and leaves any other launch failure a transport failure.
 */
export const launchFailure = (cause: unknown): Error => {
	const message = cause instanceof Error ? cause.message : String(cause)

	const library = MISSING_LIBRARY.exec(message)?.[1]
	if (library !== undefined || MISSING_DEPENDENCIES.test(message)) {
		const what = library === undefined ? 'system libraries' : `a system library (${library})`
		return new PreconditionFailure(
			`Chromium cannot start because this machine is missing ${what} it needs. ` +
				'On Debian or Ubuntu, including WSL, run `make browser-deps` in the drexbot folder; it asks for sudo. ' +
				"Elsewhere, install Chromium's libraries with your package manager.",
			{ cause },
		)
	}

	const expected = NOT_INSTALLED.exec(message)?.[1]
	if (expected !== undefined) {
		return new PreconditionFailure(
			`Chromium is not installed where this version of Playwright looks for it (${expected}). ` +
				'Run `make setup` in the drexbot folder.',
			{ cause },
		)
	}

	return new TransportFailure(`could not start a browser: ${message}`, { cause })
}

/** Starts the Chromium that Playwright manages, failing with a reason that says what to do. */
export const launchChromium = async (headless = true): Promise<Browser> => {
	try {
		return await chromium.launch({ headless })
	} catch (cause) {
		throw launchFailure(cause)
	}
}
