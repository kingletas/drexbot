import { launchChromium } from '../../surfaces/browser-launch.js'

/** Starts Chromium and closes it, so a machine that cannot run a browser check hears why before a run. */
export const checkBrowser = async (): Promise<number> => {
	try {
		const browser = await launchChromium()
		await browser.close()
		process.stdout.write('drexbot: Chromium starts on this machine\n')
		return 0
	} catch (cause) {
		process.stderr.write(`drexbot: ${cause instanceof Error ? cause.message : String(cause)}\n`)
		return 1
	}
}
