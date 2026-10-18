/**
 * A8 — the chosen plan scores strictly better than doing nothing
 * A9 — a decision verified at an older graph revision is refused at commit
 */

import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  buildPlans,
  chooseBest,
  commitDecision,
  evaluateAll,
  findCandidates,
  run,
  scorePlan,
  StaleDecisionError,
  traceCascade,
  writeDecision,
  type Session,
} from '@slackline/graph'
import { DISRUPTION_ID, describeGraph, openTestSession, reseed } from './helpers.js'

describeGraph('plan evaluation and commit', () => {
  let session: Session

  beforeAll(async () => {
    session = await openTestSession()
  })

  afterAll(async () => {
    await session?.close()
  })

  it('A8 — the chosen plan beats the do-nothing baseline', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)

    const candidates = await findCandidates(session.graph, { threshold: 0 })
    const plans = buildPlans(candidates)
    expect(plans.length).toBeGreaterThan(1) // baseline plus real options

    const evaluations = await evaluateAll(session.db, session.name, plans, {
      disruptionId: DISRUPTION_ID,
    })

    const baseline = evaluations.find((e) => e.plan.actions.length === 0)
    expect(baseline, 'the baseline plan must always be evaluated').toBeDefined()

    const best = chooseBest(evaluations)
    expect(best, 'at least one plan must pass all invariants').not.toBeNull()
    expect(best!.verified).toBe(true)

    if (baseline!.verified) {
      // Doing nothing is legal, so acting has to actually be an improvement.
      expect(best!.score.score).toBeLessThan(baseline!.score.score)
    } else {
      // Doing nothing is NOT legal — the disruption pushes the schedule past a
      // hard constraint on its own. Then "beat the baseline" is the wrong test:
      // the baseline is not an available option at any score. What must hold is
      // that a legal plan exists and is the cheapest among legal plans.
      const verified = evaluations.filter((e) => e.verified)
      expect(verified.length).toBeGreaterThan(0)
      expect(best!.score.score).toBe(Math.min(...verified.map((e) => e.score.score)))
    }
  })

  it('the chosen plan is always the cheapest VERIFIED plan, never a cheaper rejected one', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)

    const candidates = await findCandidates(session.graph, { threshold: 0 })
    const evaluations = await evaluateAll(session.db, session.name, buildPlans(candidates), {
      disruptionId: DISRUPTION_ID,
    })
    const best = chooseBest(evaluations)
    if (!best) return

    // A rejected plan may well score lower — cancelling nothing usually does.
    // It must never be chosen. Safety is not traded against the objective.
    for (const e of evaluations) {
      if (!e.verified) continue
      expect(best.score.score).toBeLessThanOrEqual(e.score.score)
    }
    expect(best.violations).toEqual([])
  })

  it('every candidate came from the graph, not from the orchestrator', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)

    const candidates = await findCandidates(session.graph, { threshold: 0 })

    // Each cancel pair must really be an out-and-back on a NEXT_LEG edge.
    for (const pair of candidates.cancelPairs.slice(0, 5)) {
      const rows = await run<{ n: number }>(
        session.graph,
        `MATCH (a:Flight {id: $out})-[:NEXT_LEG]->(b:Flight {id: $back})
         WHERE a.dep_code = b.arr_code
         RETURN count(*) AS n`,
        { out: pair.leg_out, back: pair.leg_back },
      )
      expect(Number(rows[0]?.n)).toBe(1)
    }
  })

  it('A9 — a decision is refused once the graph has moved beneath it', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)

    const candidates = await findCandidates(session.graph, { threshold: 0 })
    const plans = buildPlans(candidates)
    const evaluations = await evaluateAll(session.db, session.name, plans, {
      disruptionId: DISRUPTION_ID,
    })
    const best = chooseBest(evaluations)
    expect(best).not.toBeNull()

    const score = await scorePlan(session.graph)
    const decisionId = 'decision-stale-test'
    await writeDecision(session.graph, {
      id: decisionId,
      cascadeRoot: 'test',
      plan: best!.plan,
      evidence: {},
      score,
      affected: [],
    })

    // Someone else changes the world between verify and commit.
    await run(session.graph, 'MATCH (m:Meta {id:"rev"}) SET m.n = m.n + 1')

    await expect(
      commitDecision(session.graph, decisionId, { disruptionId: DISRUPTION_ID }),
    ).rejects.toBeInstanceOf(StaleDecisionError)

    // And it refused without applying anything: the decision is still VERIFIED.
    const status = (
      await run<{ status: string }>(
        session.graph,
        'MATCH (d:Decision {id: $id}) RETURN d.status AS status',
        { id: decisionId },
      )
    )[0]
    expect(status?.status).toBe('VERIFIED')
  })

  it('a fresh decision commits, writes a receipt and bumps the revision', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)

    const candidates = await findCandidates(session.graph, { threshold: 0 })
    const evaluations = await evaluateAll(session.db, session.name, buildPlans(candidates), {
      disruptionId: DISRUPTION_ID,
    })
    const best = chooseBest(evaluations)!

    const before = await scorePlan(session.graph)
    const decisionId = 'decision-commit-test'
    await writeDecision(session.graph, {
      id: decisionId,
      cascadeRoot: 'test',
      plan: best.plan,
      evidence: {},
      score: before,
      affected: [],
    })

    const receipt = await commitDecision(session.graph, decisionId, {
      disruptionId: DISRUPTION_ID,
    })

    expect(receipt.new_rev).toBe(1)
    expect(receipt.after.score).toBeLessThanOrEqual(before.score)

    const linked = (
      await run<{ n: number }>(
        session.graph,
        'MATCH (r:Receipt {id: $id})-[:FOR]->(d:Decision) RETURN count(d) AS n',
        { id: receipt.id },
      )
    )[0]
    expect(Number(linked?.n)).toBe(1)

    // The same decision cannot be committed twice.
    await expect(
      commitDecision(session.graph, decisionId, { disruptionId: DISRUPTION_ID }),
    ).rejects.toBeInstanceOf(StaleDecisionError)
  })
})
