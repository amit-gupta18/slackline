/**
 * A2 — relaxation converges
 * A3 — cascade arithmetic on a hand-built chain with known slack
 * A4 — a flight takes the MAX of its aircraft and crew inbound delays
 */

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  applySchema,
  readCascade,
  relaxToFixpoint,
  run,
  seedDisruption,
  traceCascade,
  wipe,
  type Session,
} from '@slackline/graph'
import { DISRUPTION_ID, describeGraph, openTestSession, reseed } from './helpers.js'

describeGraph('cascade', () => {
  let session: Session

  beforeAll(async () => {
    session = await openTestSession()
  })

  afterAll(async () => {
    await session?.close()
  })

  it('A2 — reaches fixpoint, and the final wave changes nothing', async () => {
    await reseed(session)
    const result = await traceCascade(session.graph, DISRUPTION_ID)

    expect(result.seeded).toBeGreaterThan(0)
    expect(result.iterations).toBeLessThan(50)
    expect(result.waves.at(-1)).toBe(0)
    // The cascade must actually spread, or the test proves nothing.
    expect(result.affected.length).toBeGreaterThan(result.seeded)
  })

  it('A3 — delays match hand-computed arithmetic on a 5-flight chain', async () => {
    // A chain of 5 legs with slack 20 at each hand-off, shocked by +120.
    // Expected: 120, 100, 80, 60, 40.
    await wipe(session.graph)
    await applySchema(session.graph)
    await buildChain(session, { legs: 5, slack: 20, shock: 120 })

    const seeded = await seedDisruption(session.graph, 'chain-shock')
    expect(seeded).toBe(1)

    await relaxToFixpoint(session.graph)

    const rows = await run<{ id: string; delay: number }>(
      session.graph,
      'MATCH (f:Flight) RETURN f.id AS id, f.delay_min AS delay ORDER BY f.id',
    )
    expect(rows.map((r) => Number(r.delay))).toEqual([120, 100, 80, 60, 40])
  })

  it('A4 — a flight takes the larger of its inbound aircraft and crew delays', async () => {
    await wipe(session.graph)
    await applySchema(session.graph)

    // TAIL and CREWIN both feed TARGET. The aircraft hand-off has slack 50,
    // the crew hand-off has slack 10 — so the crew path is the binding one.
    await run(
      session.graph,
      `
      CREATE (tail:Flight   {id:'F-TAIL',  flight_no:'F1', dep_code:'DEL', arr_code:'BOM',
                             sched_dep:300, sched_arr:400, proj_dep:300, proj_arr:400,
                             delay_min:100, pax:100, seats:186, status:'SCHEDULED'})
      CREATE (crew:Flight   {id:'F-CREW',  flight_no:'F2', dep_code:'DEL', arr_code:'BOM',
                             sched_dep:300, sched_arr:400, proj_dep:300, proj_arr:400,
                             delay_min:100, pax:100, seats:186, status:'SCHEDULED'})
      CREATE (target:Flight {id:'F-TARGET', flight_no:'F3', dep_code:'BOM', arr_code:'DEL',
                             sched_dep:500, sched_arr:600, proj_dep:500, proj_arr:600,
                             delay_min:0, pax:100, seats:186, status:'SCHEDULED'})
      CREATE (tail)-[:NEXT_LEG  {min_turn:40, sched_ground:90, slack_min:50}]->(target)
      CREATE (crew)-[:CREW_NEXT {min_rest:45, sched_ground:55, slack_min:10}]->(target)
      `,
    )

    await relaxToFixpoint(session.graph)

    const row = (
      await run<{ delay: number }>(
        session.graph,
        "MATCH (f:Flight {id:'F-TARGET'}) RETURN f.delay_min AS delay",
      )
    )[0]

    // aircraft path gives 100-50 = 50; crew path gives 100-10 = 90. Takes 90.
    expect(Number(row?.delay)).toBe(90)
  })

  it('reads the cascade in deterministic order', async () => {
    await reseed(session)
    await traceCascade(session.graph, DISRUPTION_ID)

    const first = await readCascade(session.graph)
    const second = await readCascade(session.graph)
    expect(first).toEqual(second)

    // Ordered by delay desc, then id — never non-deterministic.
    for (let i = 0; i + 1 < first.length; i++) {
      const a = first[i]!
      const b = first[i + 1]!
      expect(a.delay > b.delay || (a.delay === b.delay && a.flight <= b.flight)).toBe(true)
    }
  })
})

/** A straight chain of legs with uniform slack, plus a disruption that hits leg 1. */
async function buildChain(
  session: Session,
  opts: { legs: number; slack: number; shock: number },
): Promise<void> {
  const minTurn = 40
  const ground = minTurn + opts.slack

  for (let i = 0; i < opts.legs; i++) {
    const dep = 300 + i * 200
    await run(
      session.graph,
      `CREATE (f:Flight {id: $id, flight_no: $id, dep_code: $dep_code, arr_code: 'BOM',
                         sched_dep: $dep, sched_arr: $arr, proj_dep: $dep, proj_arr: $arr,
                         delay_min: 0, pax: 100, seats: 186, status: 'SCHEDULED'})`,
      {
        id: `F${i + 1}`,
        // Only the first leg departs DEL, so only it is seeded by the disruption.
        dep_code: i === 0 ? 'DEL' : 'BLR',
        dep,
        arr: dep + 100,
      },
    )
  }

  for (let i = 0; i + 1 < opts.legs; i++) {
    await run(
      session.graph,
      `MATCH (a:Flight {id: $from}), (b:Flight {id: $to})
       CREATE (a)-[:NEXT_LEG {min_turn: $min_turn, sched_ground: $ground, slack_min: $slack}]->(b)`,
      { from: `F${i + 1}`, to: `F${i + 2}`, min_turn: minTurn, ground, slack: opts.slack },
    )
  }

  await run(
    session.graph,
    `CREATE (d:Disruption {id:'chain-shock', kind:'FOG', airport_code:'DEL',
                           start_min: 0, end_min: 1440, impact_min: $shock})`,
    { shock: opts.shock },
  )
}
