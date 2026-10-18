/**
 * The product. Everything the API, the demo and (in Phase 2) the MCP server
 * are allowed to call lives behind this barrel.
 *
 * This package must never import mongoose — accounts are the app shell, not
 * the decision path. `pnpm lint:boundary` enforces it.
 */

export * from './config.js'
export * from './db.js'
export * from './schema.js'
export * from './generate.js'
export * from './ingest.js'
export * from './cascade.js'
export * from './invariants.js'
export * from './candidates.js'
export * from './plan.js'
export * from './commit.js'
export * from './fragility.js'
export * from './replay.js'
export * from './stress.js'
export * from './recovery.js'
export * as queries from './queries.js'
