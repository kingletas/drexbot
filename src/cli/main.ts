import { registryOf, runCli, type Harness } from 'harness-kernel'
import { WORKSPACE } from '../workspace.js'
import { magentoTarget } from '../magento/adapter.js'
import { captureBaseline } from './commands/baseline.js'
import { checkBrowser } from './commands/browser.js'

const harness: Harness = {
	name: 'drexbot',
	registry: registryOf({ magento: magentoTarget }),
	workspace: WORKSPACE,
}

// Commands the shared set does not have: a storefront's checks need facts about a
// catalogue, and a browser that can start on this machine.
process.exitCode = await runCli(harness, process.argv.slice(2), {
	baseline: {
		usage: 'baseline --target <name>   Capture what this store is, for the checks to read',
		run: (self, options) => captureBaseline(self, options),
	},
	browser: {
		usage: 'browser                    Start Chromium once, and say what to install if it cannot',
		run: () => checkBrowser(),
	},
})
