import { registryOf, runCli, type Harness } from '@harness/kernel'
import { WORKSPACE } from '../workspace.js'
import { magentoTarget } from '../magento/adapter.js'
import { captureBaseline } from './commands/baseline.js'

const harness: Harness = {
	name: 'drexbot',
	registry: registryOf({ magento: magentoTarget }),
	workspace: WORKSPACE,
}

// The one command the shared set does not have: a storefront is the only target
// whose checks need facts about a catalogue before they can ask for anything.
process.exitCode = await runCli(harness, process.argv.slice(2), {
	baseline: {
		usage: 'baseline --target <name>   Capture what this store is, for the checks to read',
		run: (self, options) => captureBaseline(self, options),
	},
})
