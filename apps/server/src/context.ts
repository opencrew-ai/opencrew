import type { DB } from './db'
import type { Hub } from './hub'
import type { FabricRuntime } from './fabric/runtime'

/**
 * App context — deliberately thin. The task fabric (see /DESIGN.md) keeps
 * ALL coordination state in the database; the runtime here is the in-process
 * worker pool + control loops, not a state store. Nothing in memory is ever
 * required for correctness — that's what makes the server crash-only.
 */
export interface AppContext {
  db: DB
  hub: Hub
  fabric: FabricRuntime
}
