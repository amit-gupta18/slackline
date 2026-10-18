/**
 * The single writer.
 *
 * This is the only module permitted to mutate the live graph after ingest.
 * It takes a decision id and nothing else — never a plan body. That is the
 * structural guarantee that no caller (and in Phase 2, no model) can smuggle
 * in an action that was never verified.
 */

import type { Plan, Receipt, Score } from '@slackline/shared'
import { randomUUID } from 'node:crypto'
import { relaxToFixpoint, seedDisruption } from './cascade.js'
import { run, runOne, type Graph } from './db.js'
import { applyPlan, scorePlan } from './plan.js'
import {
  BUMP_REVISION_AND_WRITE_RECEIPT,
  CLAIM_DECISION_FOR_COMMIT,
  READ_DECISION,
  RESET_CASCADE,
} from './queries.js'

export class StaleDecisionError extends Error {
  constructor(
    readonly decisionId: string,
    readonly decisionRev: number | null,
    readonly currentRev: number | null,
  ) {
    super(
      `decision ${decisionId} is stale or not VERIFIED: it was verified at graph revision ` +
        `${decisionRev ?? '?'}, the live graph is now at ${currentRev ?? '?'}. Re-verify before committing.`,
    )
    this.name = 'StaleDecisionError'
  }
}

export interface CommitOptions {
  /** The disruption to re-propagate from after the plan is applied. */
  disruptionId: string
}

/**
 * Apply a verified decision to the live graph and write its receipt.
 *
 * Refuses if the decision is not VERIFIED, or if the live graph has moved since
 * it was verified (d.graph_rev <> m.n). The refusal is the point: a plan proven
 * safe against one state of the world is not proven safe against another.
 */
export async function commitDecision(
  graph: Graph,
  decisionId: string,
  options: CommitOptions,
): Promise<Receipt> {
  const before = await scorePlan(graph)

  // Claim the decision. Zero rows means it was stale or not VERIFIED, and the
  // claim has already failed without touching anything.
  const claimed = await run<{ plan: string }>(graph, CLAIM_DECISION_FOR_COMMIT, {
    decision_id: decisionId,
  })

  const claim = claimed[0]
  if (!claim) {
    const decision = (
      await run<{ graph_rev: number; status: string }>(graph, READ_DECISION, {
        decision_id: decisionId,
      })
    )[0]
    const current = (
      await run<{ n: number }>(graph, 'MATCH (m:Meta {id:"rev"}) RETURN m.n AS n')
    )[0]
    throw new StaleDecisionError(
      decisionId,
      decision ? Number(decision.graph_rev) : null,
      current ? Number(current.n) : null,
    )
  }

  const plan = JSON.parse(claim.plan) as Plan

  // Apply for real, then re-propagate so the live graph reflects the new world.
  await applyPlan(graph, plan)
  await run(graph, RESET_CASCADE)
  await seedDisruption(graph, options.disruptionId)
  await relaxToFixpoint(graph)

  const after = await scorePlan(graph)
  const receiptId = `receipt-${randomUUID().slice(0, 8)}`

  const row = await runOne<{ receipt_id: string; new_rev: number }>(
    graph,
    BUMP_REVISION_AND_WRITE_RECEIPT,
    {
      decision_id: decisionId,
      receipt_id: receiptId,
      now: new Date().toISOString(),
      before: JSON.stringify(before),
      after: JSON.stringify(after),
    },
  )

  return {
    id: String(row.receipt_id),
    decision_id: decisionId,
    applied_at: new Date().toISOString(),
    before,
    after,
    new_rev: Number(row.new_rev),
  }
}

export type { Score }
