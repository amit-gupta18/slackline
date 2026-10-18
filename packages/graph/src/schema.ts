/**
 * Indexes and unique constraints.
 *
 * Order matters: indexes first, then constraints, then ingest. Constraint
 * creation is asynchronous on FalkorDB (it replies PENDING), so applyConstraints
 * waits for them to report OPERATIONAL before returning.
 */

import { ConstraintType, EntityType } from 'falkordb'
import { INDEXES, UNIQUE_CONSTRAINTS, INIT_REVISION, WIPE_GRAPH } from './queries.js'
import { run, type Graph } from './db.js'

/**
 * Create every index. Re-running is safe: FalkorDB errors on a duplicate
 * index, and an already-present index is not a failure for our purposes.
 */
export async function applyIndexes(graph: Graph): Promise<number> {
  let created = 0
  for (const statement of INDEXES) {
    try {
      await run(graph, statement)
      created++
    } catch (err) {
      if (!isAlreadyExists(err)) throw err
    }
  }
  return created
}

export async function applyConstraints(graph: Graph): Promise<number> {
  let created = 0
  for (const { label, property } of UNIQUE_CONSTRAINTS) {
    try {
      await graph.constraintCreate(ConstraintType.UNIQUE, EntityType.NODE, label, property)
      created++
    } catch (err) {
      if (!isAlreadyExists(err)) throw err
    }
  }
  await waitForConstraints(graph)
  return created
}

/**
 * Constraint creation returns PENDING and completes in the background. Ingest
 * started against a PENDING constraint can race it, so block until every
 * constraint is OPERATIONAL.
 */
async function waitForConstraints(graph: Graph, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await run<{ status: string }>(graph, 'CALL db.constraints() YIELD status RETURN status')
    if (rows.every((r) => String(r.status).toUpperCase() === 'OPERATIONAL')) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('constraints did not become OPERATIONAL within 10s')
}

export async function initRevision(graph: Graph): Promise<number> {
  const rows = await run<{ n: number }>(graph, INIT_REVISION)
  return Number(rows[0]?.n ?? 0)
}

/** Delete every node and relationship. Used by `pnpm seed` and by tests. */
export async function wipe(graph: Graph): Promise<void> {
  await run(graph, WIPE_GRAPH)
}

/** Full schema setup: indexes, constraints, revision counter. */
export async function applySchema(graph: Graph): Promise<{ indexes: number; constraints: number }> {
  const indexes = await applyIndexes(graph)
  const constraints = await applyConstraints(graph)
  await initRevision(graph)
  return { indexes, constraints }
}

function isAlreadyExists(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /already\s+(exists|indexed)|attempted to add an existing/i.test(message)
}
