/**
 * Cascade replay — the dependency graph, plus one snapshot per relaxation wave.
 *
 * This exists for explanation, not for decisions. Nothing here computes a
 * delay: it runs exactly the same relaxation the product runs, and records the
 * delay state the graph held after each wave so a human can watch the
 * propagation happen one hop at a time.
 *
 * It runs on a FORK, so replaying a cascade never disturbs the live graph.
 */

import type { FalkorDB } from 'falkordb'
import { MAX_RELAX_WAVES } from './config.js'
import { run, runOne, withFork, type Graph } from './db.js'
import {
  EXPORT_DELAYS,
  EXPORT_FLIGHT_NODES,
  EXPORT_HANDOFF_EDGES,
  RELAX_ONE_WAVE,
  RESET_CASCADE,
  SEED_DISRUPTION,
} from './queries.js'

export interface FlightNode {
  id: string
  no: string
  dep: string
  arr: string
  sched_dep: number
  sched_arr: number
  delay: number
  status: string
  tail: string
  crew: string
  pax: number
}

export interface HandoffEdge {
  source: string
  target: string
  kind: 'NEXT_LEG' | 'CREW_NEXT'
  slack_min: number
  sched_ground: number
}

export interface DependencyGraph {
  nodes: FlightNode[]
  edges: HandoffEdge[]
}

export interface CascadeFrame {
  /** 0 = the shock has just landed, before any propagation. */
  wave: number
  /** How many flights changed in this wave. */
  changed: number
  /** flight id -> delay minutes, for flights with delay > 0. */
  delays: Record<string, number>
  cancelled: string[]
}

export interface CascadeReplay {
  graph: DependencyGraph
  frames: CascadeFrame[]
  seeded: number
}

/** The dependency graph as it currently stands. */
export async function exportGraph(graph: Graph): Promise<DependencyGraph> {
  const [nodes, edges] = await Promise.all([
    run<FlightNode>(graph, EXPORT_FLIGHT_NODES),
    run<HandoffEdge>(graph, EXPORT_HANDOFF_EDGES),
  ])

  return {
    nodes: nodes.map((n) => ({
      id: String(n.id),
      no: String(n.no),
      dep: String(n.dep),
      arr: String(n.arr),
      sched_dep: Number(n.sched_dep),
      sched_arr: Number(n.sched_arr),
      delay: Number(n.delay),
      status: String(n.status),
      tail: String(n.tail),
      crew: String(n.crew),
      pax: Number(n.pax),
    })),
    edges: edges.map((e) => ({
      source: String(e.source),
      target: String(e.target),
      kind: e.kind as HandoffEdge['kind'],
      slack_min: Number(e.slack_min),
      sched_ground: Number(e.sched_ground),
    })),
  }
}

async function snapshot(graph: Graph): Promise<{ delays: Record<string, number>; cancelled: string[] }> {
  const rows = await run<{ id: string; delay: number; status: string }>(graph, EXPORT_DELAYS)
  const delays: Record<string, number> = {}
  const cancelled: string[] = []

  for (const row of rows) {
    const id = String(row.id)
    if (String(row.status) === 'CANCELLED') cancelled.push(id)
    const delay = Number(row.delay)
    if (delay > 0) delays[id] = delay
  }
  return { delays, cancelled }
}

/**
 * Run the cascade on a fork, capturing the delay state after every wave.
 *
 * Frame 0 is the seeded shock with nothing propagated yet; each later frame is
 * one wave of Bellman-Ford relaxation. The last frame always has changed = 0 —
 * that is what fixpoint means, and showing it is the point: the cascade stops
 * because nothing more can spill, not because we stopped looking.
 */
export async function replayCascade(
  db: FalkorDB,
  liveName: string,
  disruptionId: string,
): Promise<CascadeReplay> {
  return withFork(db, liveName, async (sim) => {
    const graph = await exportGraph(sim)

    await run(sim, RESET_CASCADE)
    const seededRow = await runOne<{ seeded: number }>(sim, SEED_DISRUPTION, {
      disruption_id: disruptionId,
    })
    const seeded = Number(seededRow.seeded)

    const frames: CascadeFrame[] = []
    const first = await snapshot(sim)
    frames.push({ wave: 0, changed: seeded, ...first })

    for (let wave = 1; wave <= MAX_RELAX_WAVES; wave++) {
      const row = await runOne<{ changed: number }>(sim, RELAX_ONE_WAVE)
      const changed = Number(row.changed)
      const state = await snapshot(sim)
      frames.push({ wave, changed, ...state })
      if (changed === 0) break
    }

    return { graph, frames, seeded }
  })
}
