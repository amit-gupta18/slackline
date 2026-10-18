/**
 * Fork -> apply -> verify -> score.
 *
 * Nothing in here is speculative on the live graph. Every plan is tried on a
 * GRAPH.COPY fork that is deleted in a finally block, so the live graph is
 * never mutated by an evaluation (AGENTS.md 3.9, acceptance test A5).
 */

import type { Action, Evaluation, Plan, Score, Violation } from '@slackline/shared'
import type { FalkorDB } from 'falkordb'
import { SCORE_WEIGHTS, SIGNIFICANT_DELAY_MIN } from './config.js'
import { relaxToFixpoint, seedDisruption } from './cascade.js'
import { run, runOne, withFork, type Graph } from './db.js'
import { checkAll } from './invariants.js'
import {
  APPLY_ABSORB,
  APPLY_CANCEL_PAIR,
  APPLY_SWAP_CREW,
  APPLY_SWAP_TAIL,
  CREATE_DECISION,
  LINK_DECISION_FLIGHTS,
  RESET_CASCADE,
  SCORE_PLAN,
} from './queries.js'

/* ------------------------------------------------------------------ */
/* Applying a plan — exactly one mutation per action type              */
/* ------------------------------------------------------------------ */

export async function applyAction(graph: Graph, action: Action): Promise<void> {
  switch (action.type) {
    case 'CANCEL_PAIR':
      await run(graph, APPLY_CANCEL_PAIR, { legs: action.legs })
      return
    case 'SWAP_TAIL':
      await run(graph, APPLY_SWAP_TAIL, {
        flight_id: action.flight,
        to_aircraft: action.to_aircraft,
      })
      return
    case 'SWAP_CREW':
      await run(graph, APPLY_SWAP_CREW, { flight_id: action.flight, to_crew: action.to_crew })
      return
    case 'ABSORB':
      await run(graph, APPLY_ABSORB, { flight_id: action.flight })
      return
    default: {
      // The union is exhaustive; this is the structural guarantee that no
      // action outside the fixed menu can ever be applied.
      const never: never = action
      throw new Error(`unknown action type: ${JSON.stringify(never)}`)
    }
  }
}

export async function applyPlan(graph: Graph, plan: Plan): Promise<void> {
  for (const action of plan.actions) {
    await applyAction(graph, action)
  }
}

/* ------------------------------------------------------------------ */
/* Scoring — every figure comes from the query                         */
/* ------------------------------------------------------------------ */

export async function scorePlan(graph: Graph): Promise<Score> {
  const row = await runOne<Omit<Score, 'score'>>(graph, SCORE_PLAN, { sig: SIGNIFICANT_DELAY_MIN })

  const paxCancelled = Number(row.pax_cancelled)
  const paxDelayMinutes = Number(row.pax_delay_minutes)
  const paxDelayHours = paxDelayMinutes / 60

  return {
    cancelled_flights: Number(row.cancelled_flights),
    pax_cancelled: paxCancelled,
    pax_delayed: Number(row.pax_delayed),
    pax_delay_minutes: paxDelayMinutes,
    total_delay_minutes: Number(row.total_delay_minutes),
    worst_delay: Number(row.worst_delay),
    // Arithmetic over graph-computed figures with declared weights. No domain
    // rule is applied here — this is the published objective function.
    score:
      paxCancelled * SCORE_WEIGHTS.paxCancelled +
      paxDelayHours * SCORE_WEIGHTS.paxDelayHours,
  }
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface EvaluateOptions {
  disruptionId: string
}

/**
 * Try one plan on a fork and report what it would do.
 *
 * The fork starts as a copy of the live graph, so it carries the live cascade.
 * The cascade is reset and re-propagated from the disruption AFTER the plan's
 * actions are applied — that is what lets a cancellation actually remove a
 * downstream delay rather than merely add to one.
 */
export async function evaluatePlan(
  db: FalkorDB,
  liveName: string,
  plan: Plan,
  options: EvaluateOptions,
): Promise<Evaluation> {
  return withFork(db, liveName, async (sim) => {
    await applyPlan(sim, plan)
    await run(sim, RESET_CASCADE)
    await seedDisruption(sim, options.disruptionId)
    await relaxToFixpoint(sim)

    const violations = await checkAll(sim)
    const score = await scorePlan(sim)

    return { plan, verified: violations.length === 0, violations, score }
  })
}

/**
 * Evaluate plans one at a time.
 *
 * Deliberately sequential: each fork is a full graph copy, and parallel forks
 * are the fastest way to exhaust a free-tier instance's memory.
 */
export async function evaluateAll(
  db: FalkorDB,
  liveName: string,
  plans: Plan[],
  options: EvaluateOptions,
): Promise<Evaluation[]> {
  const results: Evaluation[] = []
  for (const plan of plans) {
    results.push(await evaluatePlan(db, liveName, plan, options))
  }
  return results
}

/**
 * Pick the verified plan with the lowest score.
 *
 * This is the only place the orchestrator "decides" anything, and it decides by
 * comparing numbers the graph produced. Ties break on plan id so that two runs
 * with the same seed choose the same plan (acceptance test A11).
 */
export function chooseBest(evaluations: Evaluation[]): Evaluation | null {
  const verified = evaluations.filter((e) => e.verified)
  if (verified.length === 0) return null
  return verified.reduce((best, candidate) => {
    if (candidate.score.score < best.score.score) return candidate
    if (candidate.score.score > best.score.score) return best
    return candidate.plan.id < best.plan.id ? candidate : best
  })
}

/* ------------------------------------------------------------------ */
/* Decision record                                                     */
/* ------------------------------------------------------------------ */

/** Flights a plan acts on directly — used for the ACTED_ON evidence edges. */
export function flightsActedOn(plan: Plan): string[] {
  const ids = new Set<string>()
  for (const action of plan.actions) {
    if (action.type === 'CANCEL_PAIR') action.legs.forEach((id) => ids.add(id))
    else ids.add(action.flight)
  }
  return [...ids].sort()
}

export interface WriteDecisionInput {
  id: string
  cascadeRoot: string
  plan: Plan
  evidence: unknown
  score: Score
  affected: string[]
}

/**
 * Write a VERIFIED decision to the LIVE graph. Nothing is applied yet — the
 * decision records what was proven safe, at which graph revision. Commit is a
 * separate, explicit step.
 *
 * The *_json properties are stringified because FalkorDB properties are
 * scalars, not nested maps.
 */
export async function writeDecision(graph: Graph, input: WriteDecisionInput): Promise<string> {
  const row = await runOne<{ decision_id: string }>(graph, CREATE_DECISION, {
    id: input.id,
    now: new Date().toISOString(),
    root: input.cascadeRoot,
    plan: JSON.stringify(input.plan),
    evidence: JSON.stringify(input.evidence),
    score: JSON.stringify(input.score),
  })

  // Evidence edges are optional: a decision with no affected flights is still
  // a decision. Skipping an empty list avoids a no-op round trip.
  if (input.affected.length > 0) {
    await run(graph, LINK_DECISION_FLIGHTS, {
      decision_id: input.id,
      flights: input.affected,
      role: 'AFFECTED',
    })
  }

  const acted = flightsActedOn(input.plan)
  if (acted.length > 0) {
    await run(graph, LINK_DECISION_FLIGHTS, {
      decision_id: input.id,
      flights: acted,
      role: 'ACTED_ON',
    })
  }

  return String(row.decision_id)
}

export type { Violation }
