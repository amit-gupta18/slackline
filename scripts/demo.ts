/**
 * The Phase 1 end-to-end demo. `pnpm demo`
 *
 * Prints the six-step contract from docs/kickoff.md 14. Every number below
 * comes from a query result — none is computed from a domain rule in here.
 *
 * This script never connects to MongoDB. It runs with MONGODB_URI unset.
 */

import {
  buildPlans,
  chooseBest,
  commitDecision,
  connect,
  countAffected,
  describeViolation,
  evaluateAll,
  explainDelay,
  findCandidates,
  flightsActedOn,
  formatEvidence,
  generate,
  ingest,
  applySchema,
  relaxToFixpoint,
  readCascade,
  scorePlan,
  seedDisruption,
  wipe,
  writeDecision,
} from '@slackline/graph'

const SIMULATION_NOTICE = 'SIMULATION — synthetic data, generated schedule. Not a real airline operation.'

async function main() {
  const seed = 42
  const session = await connect()
  const { db, graph, name } = session

  try {
    console.log(SIMULATION_NOTICE)
    console.log('='.repeat(78))

    /* [1/6] Seed ---------------------------------------------------- */
    await wipe(graph)
    await applySchema(graph)
    const schedule = generate({ seed })
    const counts = await ingest(graph, schedule)
    console.log(
      `[1/6] Seeded graph:            ${counts.flights} flights, ${counts.aircraft} aircraft, ` +
        `${counts.crew} crew, ${counts.airports} airports`,
    )

    /* [2/6] Disruption ---------------------------------------------- */
    const disruption = schedule.disruptions[0]
    if (!disruption) throw new Error('generator produced no disruption')
    const seeded = await seedDisruption(graph, disruption.id)
    console.log(
      `[2/6] Disruption:              ${disruption.kind} at ${disruption.airport_code} ` +
        `${toClock(disruption.start_min)}-${toClock(disruption.end_min)} ` +
        `(+${disruption.impact_min} min)  → ${seeded} flights seeded`,
    )

    /* [3/6] Cascade -------------------------------------------------- */
    const { iterations } = await relaxToFixpoint(graph)
    const affected = await readCascade(graph)
    const worst = affected[0]
    console.log(
      `[3/6] Cascade (relaxation):    ${iterations} waves to fixpoint → ` +
        `${affected.length} flights affected, worst delay ${worst?.delay ?? 0} min`,
    )

    // The evidence chain is the whole point of the project, so find a real one.
    //
    // The worst-delayed flight is usually one the disruption hit DIRECTLY, and
    // a directly-hit flight has no chain leading to it — its delay did not
    // propagate from anywhere. The interesting target is the worst flight whose
    // delay ARRIVED, i.e. one that did not depart the disrupted airport inside
    // the disruption window.
    const roots = affected.filter(
      (f) => f.dep === disruption.airport_code && f.delay === disruption.impact_min,
    )
    const downstream = affected.filter((f) => !roots.some((r) => r.flight === f.flight))

    let printed = false
    for (const target of downstream) {
      for (const root of roots) {
        const path = await explainDelay(graph, root.flight, target.flight)
        if (path) {
          console.log(
            `      Evidence (${target.flight} +${target.delay}):   ${formatEvidence(path)}`,
          )
          printed = true
          break
        }
      }
      if (printed) break
    }
    if (!printed) {
      console.log('      Evidence:                no propagated chain found (all delay is direct)')
    }

    const baselineScore = await scorePlan(graph)

    /* [4/6] Candidates ----------------------------------------------- */
    const candidates = await findCandidates(graph, { threshold: 0 })
    const plans = buildPlans(candidates)
    console.log(
      `[4/6] Candidates from graph:   ${candidates.cancelPairs.length} cancel-pairs, ` +
        `${candidates.spareTails.length} spare tails, ${candidates.reserveCrew.length} reserve crew ` +
        `→ ${plans.length} plans`,
    )

    /* [5/6] Fork + verify -------------------------------------------- */
    const evaluations = await evaluateAll(db, name, plans, { disruptionId: disruption.id })
    const passed = evaluations.filter((e) => e.verified)
    const rejected = evaluations.filter((e) => !e.verified)
    console.log(
      `[5/6] Fork + verify:           ${evaluations.length} forks tested, ` +
        `${passed.length} passed invariants, ${rejected.length} rejected`,
    )
    const firstRejection = rejected.find((e) => e.plan.actions.length > 0)
    if (firstRejection?.violations[0]) {
      console.log(
        `      Rejected example:        ${firstRejection.plan.id} → ` +
          `${describeViolation(firstRejection.violations[0])}`,
      )
    }

    // If doing nothing is itself illegal, say so plainly. It is the strongest
    // thing the invariants can tell an operator: absorbing this disruption is
    // not an available option, so the question is not "act or not" but "which
    // legal action".
    const baselineEval = evaluations.find((e) => e.plan.actions.length === 0)
    if (baselineEval && !baselineEval.verified && baselineEval.violations[0]) {
      console.log(
        `      Do nothing:              NOT LEGAL → ${describeViolation(baselineEval.violations[0])}`,
      )
    }

    /* [6/6] Best plan, decision, commit ------------------------------ */
    const best = chooseBest(evaluations)
    if (!best) {
      console.log('[6/6] No plan passed the invariants. Nothing is committed.')
      return
    }

    const affectedBefore = await countAffected(graph)
    const decisionId = `decision-${Date.now().toString(36)}`
    const evidence = { cascade_root: worst?.flight ?? null, affected: affectedBefore }

    await writeDecision(graph, {
      id: decisionId,
      cascadeRoot: worst?.flight ?? '',
      plan: best.plan,
      evidence,
      score: best.score,
      affected: affected.map((f) => f.flight),
    })

    const actedOn = flightsActedOn(best.plan)
    const cancelled = best.plan.actions.filter((a) => a.type === 'CANCEL_PAIR').length * 2
    const swaps = best.plan.actions.filter((a) => a.type !== 'CANCEL_PAIR' && a.type !== 'ABSORB')

    console.log(
      `[6/6] Best verified plan:      ${cancelled} cancellations, ${swaps.length} swap(s) ` +
        `[${best.plan.id}]`,
    )
    console.log(
      `      Blast radius:            ${best.score.cancelled_flights} flights cancelled, ` +
        `${best.score.pax_cancelled} pax, acted on ${actedOn.length} flight(s)`,
    )

    const receipt = await commitDecision(graph, decisionId, { disruptionId: disruption.id })
    const affectedAfter = await countAffected(graph)

    console.log(
      `      Before → After:          ${affectedBefore} affected / score ${fmt(baselineScore.score)}` +
        `  →  ${affectedAfter} affected / score ${fmt(receipt.after.score)}`,
    )
    console.log(
      `      Passenger-hours delayed: ${fmt(baselineScore.pax_delay_minutes / 60)}` +
        `  →  ${fmt(receipt.after.pax_delay_minutes / 60)}`,
    )
    console.log(
      `      Committed as:            ${decisionId} (rev ${receipt.new_rev - 1} → ${receipt.new_rev}), ${receipt.id}`,
    )

    /* Safety property: the same decision cannot be committed twice. ---- */
    try {
      await commitDecision(graph, decisionId, { disruptionId: disruption.id })
      console.log('      [WARN] re-commit was NOT refused — the staleness guard is broken.')
    } catch {
      console.log('      Re-commit refused:       staleness guard held (decision already COMMITTED)')
    }

    console.log('='.repeat(78))
    console.log(SIMULATION_NOTICE)
  } finally {
    await session.close()
  }
}

function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function fmt(n: number): string {
  return n.toFixed(1)
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err)
  process.exit(1)
})
