/**
 * Candidate containment actions.
 *
 * Every candidate is produced by a query. This module only asks the graph what
 * is possible and assembles the returned rows into plans — it never invents an
 * option, and it never filters one on an airline rule (AGENTS.md 3.2).
 */

import type { CandidateSet, Plan } from '@slackline/shared'
import { run, type Graph } from './db.js'
import {
  CANDIDATES_CANCEL_PAIRS,
  CANDIDATES_RESERVE_CREW,
  CANDIDATES_SPARE_TAILS,
  WORST_DELAYED_FLIGHTS,
} from './queries.js'

export interface CandidateOptions {
  /** Only consider flights delayed by more than this many minutes. */
  threshold?: number
  /** How many of the worst-delayed flights to seek swaps for. */
  focusFlights?: number
}

export async function findCandidates(
  graph: Graph,
  options: CandidateOptions = {},
): Promise<CandidateSet> {
  const { threshold = 0, focusFlights = 5 } = options

  const cancelPairs = (
    await run<{ leg_out: string; leg_back: string; pax_cost: number; delay_at_root: number }>(
      graph,
      CANDIDATES_CANCEL_PAIRS,
      { threshold },
    )
  ).map((r) => ({
    leg_out: String(r.leg_out),
    leg_back: String(r.leg_back),
    pax_cost: Number(r.pax_cost),
    delay_at_root: Number(r.delay_at_root),
  }))

  const worst = await run<{ flight: string; delay: number }>(graph, WORST_DELAYED_FLIGHTS, {
    threshold,
    limit: focusFlights,
  })

  const spareTails: CandidateSet['spareTails'] = []
  const reserveCrew: CandidateSet['reserveCrew'] = []

  for (const { flight } of worst) {
    const flightId = String(flight)

    for (const row of await run<{ aircraft: string; station: string }>(
      graph,
      CANDIDATES_SPARE_TAILS,
      { flight_id: flightId },
    )) {
      spareTails.push({
        flight: flightId,
        aircraft: String(row.aircraft),
        station: String(row.station),
      })
    }

    for (const row of await run<{ crew: string; slack_left: number }>(
      graph,
      CANDIDATES_RESERVE_CREW,
      { flight_id: flightId },
    )) {
      reserveCrew.push({
        flight: flightId,
        crew: String(row.crew),
        slack_left: Number(row.slack_left),
      })
    }
  }

  return { cancelPairs, spareTails, reserveCrew }
}

/**
 * Turn graph-returned candidates into plans to evaluate.
 *
 * Plan 0 is always the do-nothing baseline — without it there is nothing to
 * claim an improvement against (acceptance test A8).
 *
 * Deterministic: candidates arrive from the graph already ordered with a
 * tie-breaker, and this walks them in order.
 */
export function buildPlans(candidates: CandidateSet, maxPlans = 12): Plan[] {
  const plans: Plan[] = [{ id: 'plan-0000-baseline', actions: [] }]
  let seq = 0
  const nextId = () => `plan-${String(++seq).padStart(4, '0')}`

  for (const pair of candidates.cancelPairs) {
    if (plans.length >= maxPlans) break
    plans.push({
      id: nextId(),
      actions: [{ type: 'CANCEL_PAIR', legs: [pair.leg_out, pair.leg_back] }],
    })
  }

  for (const tail of candidates.spareTails) {
    if (plans.length >= maxPlans) break
    plans.push({
      id: nextId(),
      actions: [{ type: 'SWAP_TAIL', flight: tail.flight, to_aircraft: tail.aircraft }],
    })
  }

  for (const crew of candidates.reserveCrew) {
    if (plans.length >= maxPlans) break
    plans.push({
      id: nextId(),
      actions: [{ type: 'SWAP_CREW', flight: crew.flight, to_crew: crew.crew }],
    })
  }

  // One combined plan: the cheapest cancel pair plus the best available swap.
  const cheapestPair = candidates.cancelPairs[0]
  const bestTail = candidates.spareTails[0]
  if (cheapestPair && bestTail && plans.length < maxPlans) {
    plans.push({
      id: nextId(),
      actions: [
        { type: 'CANCEL_PAIR', legs: [cheapestPair.leg_out, cheapestPair.leg_back] },
        { type: 'SWAP_TAIL', flight: bestTail.flight, to_aircraft: bestTail.aircraft },
      ],
    })
  }

  return plans
}
