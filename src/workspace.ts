import { join } from 'node:path'
import { workspaceAt } from 'harness-kernel'

/**
 * Where this tool keeps what it writes. The one place in the package that
 * counts its own depth, so moving anything else cannot repoint the ledgers.
 */
export const WORKSPACE = workspaceAt(join(import.meta.dirname, '..', '..'))
