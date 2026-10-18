/**
 * A6 — cancelling a single mid-rotation leg trips INV-3; cancelling the
 *      out-and-back pair does not
 * A7 — pushing a crew past its duty limit trips INV-1
 *
 * Plus: the generated baseline must be clean. If it is not, no plan could
 * ever verify and every other test is meaningless.
 */

import { afterAll, beforeAll, expect, it } from 'vitest'
import { applyPlan, checkAll, run, traceCascade, withFork, type Session } from '@slackline/graph'
import { DISRUPTION_ID, describeGraph, openTestSession, reseed } from './helpers.js'

describeGraph('invariants', () => {
  let session: Session

  beforeAll(async () => {
    session = await openTestSession()
    await reseed(session)
  })

  afterAll(async () => {
    await session?.close()
  })

  it('the generated baseline satisfies all four invariants', async () => {
    const violations = await checkAll(session.graph)
    expect(violations).toEqual([])
  })

  it('stays clean after the cascade propagates (delay alone breaks nothing)', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)
    const violations = await checkAll(session.graph)
    // A delay that breaks a turnaround IS a real violation, so this asserts
    // only on the structural invariants that delay cannot affect.
    const structural = violations.filter((v) => v.invariant === 'INV-3' || v.invariant === 'INV-4')
    expect(structural).toEqual([])
  })

  it('A6 — cancelling one mid-rotation leg trips INV-3, cancelling the pair does not', async () => {
    await reseed(session)

    // Find an aircraft with an out-and-back: a -> b where b returns to a's origin.
    const pair = (
      await run<{ leg_out: string; leg_back: string }>(
        session.graph,
        `MATCH (a:Flight)-[:NEXT_LEG]->(b:Flight)
         WHERE a.dep_code = b.arr_code
         RETURN a.id AS leg_out, b.id AS leg_back
         ORDER BY a.id LIMIT 1`,
      )
    )[0]

    expect(pair, 'generator produced no out-and-back pair to test with').toBeDefined()

    // Cancel only the outbound leg — the aircraft is now stranded downroute.
    const single = await withFork(session.db, session.name, async (sim) => {
      await applyPlan(sim, {
        id: 'test-single',
        actions: [{ type: 'CANCEL_PAIR', legs: [pair!.leg_out, pair!.leg_out] }],
      })
      return checkAll(sim)
    })
    expect(single.map((v) => v.invariant)).toContain('INV-3')

    // Cancel both legs of the pair — continuity is preserved.
    const both = await withFork(session.db, session.name, async (sim) => {
      await applyPlan(sim, {
        id: 'test-pair',
        actions: [{ type: 'CANCEL_PAIR', legs: [pair!.leg_out, pair!.leg_back] }],
      })
      return checkAll(sim)
    })
    expect(both.map((v) => v.invariant)).not.toContain('INV-3')
  })

  it('A7 — pushing a crew past its duty limit trips INV-1', async () => {
    await reseed(session)

    const violations = await withFork(session.db, session.name, async (sim) => {
      // Shrink one crew's duty limit below its actual working span. The query,
      // not the test, decides that this is illegal.
      await run(
        sim,
        `MATCH (c:Crew)-[:ASSIGNED_TO]->(f:Flight)
         WHERE f.status = 'SCHEDULED' AND c.is_reserve = false
         WITH c, min(f.proj_dep) AS first_dep, max(f.proj_arr) AS last_arr
         ORDER BY c.id LIMIT 1
         SET c.duty_limit_min = (last_arr - first_dep) - 1
         RETURN c.id AS crew`,
      )
      return checkAll(sim)
    })

    expect(violations.map((v) => v.invariant)).toContain('INV-1')
    const inv1 = violations.find((v) => v.invariant === 'INV-1')
    expect(inv1?.rows.length).toBeGreaterThan(0)
  })

  it('INV-4 catches a flight with no terminal status', async () => {
    const violations = await withFork(session.db, session.name, async (sim) => {
      await run(sim, "MATCH (f:Flight) WITH f LIMIT 1 SET f.status = 'WOBBLY'")
      return checkAll(sim)
    })
    expect(violations.map((v) => v.invariant)).toContain('INV-4')
  })
})
