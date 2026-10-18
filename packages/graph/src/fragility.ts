/**
 * Which hand-offs carry the most risk.
 *
 * Nothing here ranks anything — the query does. This module calls it and
 * converts the rows.
 */

import { run, type Graph } from './db.js'
import { RANK_FRAGILE_HANDOFFS } from './queries.js'

export interface FragileHandoff {
  from_flight: string
  to_flight: string
  kind: 'NEXT_LEG' | 'CREW_NEXT'
  slack_min: number
  /** Flights reachable downstream of this hand-off. */
  blast_radius: number
  /** Passengers on those downstream flights. */
  pax_at_risk: number
}

/**
 * Rank hand-offs by thin slack in front of a large downstream blast radius.
 *
 * This is descendant-count centrality, not betweenness. Describe it as
 * "how much of the network sits behind this hand-off", never as a claim about
 * a classical centrality measure we did not compute.
 */
export async function rankFragileHandoffs(graph: Graph, limit = 20): Promise<FragileHandoff[]> {
  const rows = await run<FragileHandoff>(graph, RANK_FRAGILE_HANDOFFS, { limit })
  return rows.map((r) => ({
    from_flight: String(r.from_flight),
    to_flight: String(r.to_flight),
    kind: r.kind as FragileHandoff['kind'],
    slack_min: Number(r.slack_min),
    blast_radius: Number(r.blast_radius),
    pax_at_risk: Number(r.pax_at_risk),
  }))
}
