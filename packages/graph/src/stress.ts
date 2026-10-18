/**
 * Stress testing — "what would break if this happened?"
 *
 * Every scenario runs on a GRAPH.COPY fork and is thrown away. The live graph
 * is never touched, so a stress test can be run against the real operating
 * state at any time without risk.
 */

import type { FalkorDB } from 'falkordb'
import type { DisruptionKind, Violation } from '@slackline/shared'
import { relaxToFixpoint, seedDisruption } from './cascade.js'
import { run, withFork, type Graph } from './db.js'
import { checkAll } from './invariants.js'
import { scorePlan } from './plan.js'
import { CREATE_SCENARIO_DISRUPTION, MISSING_SLACK_RANKING, RESET_CASCADE } from './queries.js'

export interface Scenario {
  airport_code: string
  kind?: DisruptionKind
  start_min?: number
  end_min?: number
  impact_min?: number
}

export interface MissingSlack {
  from_flight: string
  to_flight: string
  kind: 'NEXT_LEG' | 'CREW_NEXT'
  slack_min: number
  inbound_delay: number
  /** How many more minutes of buffer this hand-off would have needed. */
  slack_short_by: number
  pax_affected: number
}

export interface StressResult {
  scenario: Required<Scenario>
  seeded: number
  iterations: number
  affected: number
  worst_delay: number
  /** Invariants that the scenario alone breaks, with no plan applied. */
  breakages: Violation[]
  /** The hand-offs that ran out of buffer, worst first. */
  missing_slack: MissingSlack[]
}

/**
 * Run a what-if disruption on a fork and report what breaks.
 *
 * Note what this does NOT do: it proposes nothing. It reports where the
 * schedule ran out of slack. Choosing what to do about that is a separate,
 * verified step.
 */
export async function stressTest(
  db: FalkorDB,
  liveName: string,
  scenario: Scenario,
  limit = 15,
): Promise<StressResult> {
  const full: Required<Scenario> = {
    airport_code: scenario.airport_code,
    kind: scenario.kind ?? 'FOG',
    start_min: scenario.start_min ?? 330,
    end_min: scenario.end_min ?? 510,
    impact_min: scenario.impact_min ?? 120,
  }

  return withFork(db, liveName, async (sim) => {
    const scenarioId = `scenario-${full.airport_code}-${full.start_min}-${full.impact_min}`

    // Start from the published schedule, not from whatever the live cascade
    // happens to be — a stress test asks "what if this happened", on its own.
    await run(sim, RESET_CASCADE)
    await run(sim, CREATE_SCENARIO_DISRUPTION, { id: scenarioId, ...full })

    const seeded = await seedDisruption(sim, scenarioId)
    const { iterations } = await relaxToFixpoint(sim)

    const breakages = await checkAll(sim)
    const score = await scorePlan(sim)
    const missing_slack = await readMissingSlack(sim, limit)

    const affectedRow = (
      await run<{ n: number }>(
        sim,
        "MATCH (f:Flight) WHERE f.status = 'SCHEDULED' AND f.delay_min > 0 RETURN count(f) AS n",
      )
    )[0]

    return {
      scenario: full,
      seeded,
      iterations,
      affected: Number(affectedRow?.n ?? 0),
      worst_delay: score.worst_delay,
      breakages,
      missing_slack,
    }
  })
}

async function readMissingSlack(graph: Graph, limit: number): Promise<MissingSlack[]> {
  const rows = await run<MissingSlack>(graph, MISSING_SLACK_RANKING, { limit })
  return rows.map((r) => ({
    from_flight: String(r.from_flight),
    to_flight: String(r.to_flight),
    kind: r.kind as MissingSlack['kind'],
    slack_min: Number(r.slack_min),
    inbound_delay: Number(r.inbound_delay),
    slack_short_by: Number(r.slack_short_by),
    pax_affected: Number(r.pax_affected),
  }))
}
