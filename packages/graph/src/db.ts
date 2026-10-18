/**
 * The only module that knows how to reach FalkorDB.
 *
 * There is no fallback datastore and no cache. If FalkorDB is unreachable,
 * every call in here throws, and the product fails loudly — that is the
 * behaviour tests/graph-off.test.ts asserts (hackathon Rule 3).
 */

import { FalkorDB } from 'falkordb'
import { randomUUID } from 'node:crypto'
import { loadConfig, type Config } from './config.js'

export type Graph = ReturnType<FalkorDB['selectGraph']>

export interface Session {
  db: FalkorDB
  graph: Graph
  name: string
  close: () => Promise<void>
}

/**
 * Translate config into client options.
 *
 * When the password is supplied separately we do NOT pass `url`: the client
 * parses credentials out of the URL's userinfo and those win, so a URL like
 * `falkor://user@host` (username, empty password) silently overrides an
 * explicit password and the server answers WRONGPASS. Passing host/port on
 * `socket` with `username`/`password` alongside avoids that entirely, and
 * means the password never has to be percent-encoded.
 */
function connectOptions(cfg: Config): Parameters<typeof FalkorDB.connect>[0] {
  if (!cfg.password) return { url: cfg.falkorUrl }

  const parsed = new URL(cfg.falkorUrl)
  const tls = parsed.protocol === 'falkors:' || parsed.protocol === 'rediss:'

  return {
    socket: { host: parsed.hostname, port: Number(parsed.port), tls } as never,
    username: cfg.username ?? (parsed.username || undefined),
    password: cfg.password,
  }
}

/** Open a connection and select the live graph. */
export async function connect(overrides: Partial<Config> = {}): Promise<Session> {
  const cfg = loadConfig(overrides)
  const db = await FalkorDB.connect(connectOptions(cfg))
  return {
    db,
    graph: db.selectGraph(cfg.graphName),
    name: cfg.graphName,
    close: () => db.close(),
  }
}

/**
 * Run a parameterised query and return its rows.
 *
 * Never build a query by interpolation — pass params (AGENTS.md 3.8).
 */
export async function run<T = Record<string, unknown>>(
  graph: Graph,
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const reply = await graph.query<T>(query, params ? { params: params as never } : undefined)
  return (reply.data ?? []) as T[]
}

/** Run a query expected to return exactly one row. Throws if it does not. */
export async function runOne<T = Record<string, unknown>>(
  graph: Graph,
  query: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const rows = await run<T>(graph, query, params)
  const row = rows[0]
  if (row === undefined) throw new Error(`query returned no rows:\n${query}`)
  return row
}

/**
 * GRAPH.COPY the live graph into a throwaway simulation graph.
 *
 * Clones nodes, relationships, properties, indexes and constraints. The source
 * stays readable and writable. The destination must not already exist, hence
 * the uuid suffix.
 *
 * The caller MUST delete the fork in a `finally` block (AGENTS.md 3.9) —
 * prefer `withFork`, which does it for you.
 */
export async function fork(db: FalkorDB, srcName: string): Promise<{ sim: Graph; dest: string }> {
  const dest = `${srcName}_sim_${randomUUID().slice(0, 8)}`
  await db.selectGraph(srcName).copy(dest)
  return { sim: db.selectGraph(dest), dest }
}

/**
 * Fork, hand the fork to `fn`, and delete it no matter what happens.
 *
 * This is the only sanctioned way to evaluate anything speculatively.
 */
export async function withFork<T>(
  db: FalkorDB,
  srcName: string,
  fn: (sim: Graph, destName: string) => Promise<T>,
): Promise<T> {
  const { sim, dest } = await fork(db, srcName)
  try {
    return await fn(sim, dest)
  } finally {
    await sim.delete()
  }
}

/* ------------------------------------------------------------------ */
/* Revision counter — the staleness guard behind commit.               */
/* ------------------------------------------------------------------ */

export async function getRevision(graph: Graph): Promise<number> {
  const rows = await run<{ n: number }>(graph, 'MATCH (m:Meta {id:"rev"}) RETURN m.n AS n')
  const row = rows[0]
  if (row === undefined) throw new Error('Meta rev node missing — run `pnpm seed` first.')
  return Number(row.n)
}
