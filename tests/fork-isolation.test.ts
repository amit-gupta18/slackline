/**
 * A5 — mutating a fork leaves the live graph untouched, and the fork is
 *      deleted even when the work inside it throws.
 *
 * This is the test that makes "verify before you act" meaningful.
 */

import { afterAll, beforeAll, expect, it } from 'vitest'
import { fork, run, withFork, type Session } from '@slackline/graph'
import { describeGraph, openTestSession, reseed } from './helpers.js'

describeGraph('fork isolation', () => {
  let session: Session

  beforeAll(async () => {
    session = await openTestSession()
    await reseed(session)
  })

  afterAll(async () => {
    await session?.close()
  })

  it('A5 — mutations on the fork do not reach the live graph', async () => {
    const before = await snapshot(session)

    await withFork(session.db, session.name, async (sim) => {
      await run(sim, "MATCH (f:Flight) SET f.status = 'CANCELLED'")
      const simCancelled = (
        await run<{ n: number }>(
          sim,
          "MATCH (f:Flight) WHERE f.status = 'CANCELLED' RETURN count(f) AS n",
        )
      )[0]
      // The fork really was mutated — otherwise this test would pass vacuously.
      expect(Number(simCancelled?.n)).toBeGreaterThan(0)
    })

    const after = await snapshot(session)
    expect(after).toEqual(before)
  })

  it('A5 — the fork is deleted even when the work inside throws', async () => {
    const graphsBefore = await session.db.list()

    await expect(
      withFork(session.db, session.name, async (sim) => {
        await run(sim, "MATCH (f:Flight) SET f.status = 'CANCELLED'")
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const graphsAfter = await session.db.list()
    expect(graphsAfter.sort()).toEqual(graphsBefore.sort())
  })

  it('a fork carries the live cascade state forward', async () => {
    await run(session.graph, 'MATCH (f:Flight) WITH f LIMIT 1 SET f.delay_min = 77')

    const seen = await withFork(session.db, session.name, async (sim) => {
      const row = (
        await run<{ n: number }>(
          sim,
          'MATCH (f:Flight) WHERE f.delay_min = 77 RETURN count(f) AS n',
        )
      )[0]
      return Number(row?.n)
    })

    expect(seen).toBe(1)
    await run(session.graph, 'MATCH (f:Flight) WHERE f.delay_min = 77 SET f.delay_min = 0')
  })

  it('two forks get distinct names and do not collide', async () => {
    const a = await fork(session.db, session.name)
    const b = await fork(session.db, session.name)
    try {
      expect(a.dest).not.toBe(b.dest)
    } finally {
      await a.sim.delete()
      await b.sim.delete()
    }
  })
})

/** A content fingerprint of the live graph, used to prove it did not move. */
async function snapshot(session: Session) {
  return run(
    session.graph,
    `MATCH (f:Flight)
     RETURN f.id AS id, f.status AS status, f.delay_min AS delay,
            f.proj_dep AS proj_dep, f.proj_arr AS proj_arr
     ORDER BY f.id`,
  )
}
