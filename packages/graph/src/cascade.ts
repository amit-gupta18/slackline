/**
 * The cascade trace — the core graph computation.
 *
 * Every airline rule lives in the Cypher. The code here loops and compares a
 * count to zero; that is the whole of its responsibility (AGENTS.md 3.2).
 */

import type { AffectedFlight, CascadeResult, EvidencePath } from '@slackline/shared'
import { MAX_RELAX_WAVES } from './config.js'
import { run, runOne, type Graph } from './db.js'
import {
  COUNT_AFFECTED,
  EVIDENCE_PATH,
  READ_CASCADE,
  RELAX_ONE_WAVE,
  RESET_CASCADE,
  SEED_DISRUPTION,
} from './queries.js'

export async function seedDisruption(graph: Graph, disruptionId: string): Promise<number> {
  const row = await runOne<{ seeded: number }>(graph, SEED_DISRUPTION, { disruption_id: disruptionId })
  return Number(row.seeded)
}

/**
 * Run relaxation waves until nothing changes — Bellman-Ford to fixpoint.
 *
 * On a DAG this converges in at most (longest hand-off chain) waves. Failure to
 * converge means the generated graph contains a cycle, which is a generator
 * bug, so it throws rather than silently truncating.
 */
export async function relaxToFixpoint(
  graph: Graph,
  maxWaves = MAX_RELAX_WAVES,
): Promise<{ iterations: number; waves: number[] }> {
  const waves: number[] = []
  for (let i = 0; i < maxWaves; i++) {
    const row = await runOne<{ changed: number }>(graph, RELAX_ONE_WAVE)
    const changed = Number(row.changed)
    waves.push(changed)
    if (changed === 0) return { iterations: i + 1, waves }
  }
  throw new Error(
    `cascade did not converge in ${maxWaves} waves — the hand-off graph has a cycle`,
  )
}

export async function readCascade(graph: Graph): Promise<AffectedFlight[]> {
  const rows = await run<AffectedFlight>(graph, READ_CASCADE)
  return rows.map((r) => ({
    flight: String(r.flight),
    no: String(r.no),
    dep: String(r.dep),
    arr: String(r.arr),
    delay: Number(r.delay),
    pax: Number(r.pax),
  }))
}

export async function countAffected(graph: Graph): Promise<number> {
  const row = await runOne<{ affected: number }>(graph, COUNT_AFFECTED)
  return Number(row.affected)
}

/**
 * Clear every projected delay back to the published schedule.
 *
 * Cancellations are preserved — a cancelled flight stays cancelled; only the
 * delay projection is reset.
 */
export async function resetCascade(graph: Graph): Promise<number> {
  const row = await runOne<{ reset: number }>(graph, RESET_CASCADE)
  return Number(row.reset)
}

/**
 * Reset, seed, relax and read — the whole trace in one call.
 *
 * The reset is not optional. Relaxation is monotone: it only ever RAISES a
 * delay. Tracing a cascade over a graph that already carries one finds nothing
 * to change and reports zero propagation, so without the reset this is correct
 * exactly once and silently wrong every time after.
 */
export async function traceCascade(graph: Graph, disruptionId: string): Promise<CascadeResult> {
  await resetCascade(graph)
  const seeded = await seedDisruption(graph, disruptionId)
  const { iterations, waves } = await relaxToFixpoint(graph)
  const affected = await readCascade(graph)
  return { seeded, iterations, waves, affected }
}

/**
 * "Why is this flight late?" — the shortest chain of hand-offs from a root
 * flight to a target flight, with the slack at each hop.
 *
 * Returns null when no chain exists, which is itself informative: the target's
 * delay did not come from that root.
 */
export async function explainDelay(
  graph: Graph,
  rootId: string,
  targetId: string,
): Promise<EvidencePath | null> {
  const rows = await run<EvidencePath>(graph, EVIDENCE_PATH, {
    root_id: rootId,
    target_id: targetId,
  })
  const row = rows[0]
  if (!row) return null
  return {
    chain: row.chain.map(String),
    hop_types: row.hop_types as EvidencePath['hop_types'],
    slack_at_each_hop: row.slack_at_each_hop.map(Number),
    hops: Number(row.hops),
  }
}

/** Format an evidence path the way the demo and the UI print it. */
export function formatEvidence(path: EvidencePath): string {
  const parts: string[] = [path.chain[0] ?? '?']
  for (let i = 0; i < path.hop_types.length; i++) {
    parts.push(`-${path.hop_types[i]}(slack ${path.slack_at_each_hop[i]})-> ${path.chain[i + 1]}`)
  }
  return parts.join(' ')
}
