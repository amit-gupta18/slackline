/**
 * A1 — indexes and constraints exist, and a duplicate Flight.id is rejected.
 */

import { afterAll, beforeAll, expect, it } from 'vitest'
import { applySchema, run, wipe, type Session } from '@slackline/graph'
import { describeGraph, openTestSession, reseed } from './helpers.js'

describeGraph('schema', () => {
  let session: Session

  beforeAll(async () => {
    session = await openTestSession()
    await wipe(session.graph)
    await applySchema(session.graph)
  })

  afterAll(async () => {
    await session?.close()
  })

  it('A1 — the expected indexes exist', async () => {
    const rows = await run<{ label: string; properties: string[] }>(
      session.graph,
      'CALL db.indexes() YIELD label, properties RETURN label, properties',
    )
    const have = new Set(
      rows.flatMap((r) => (r.properties ?? []).map((p) => `${r.label}.${p}`)),
    )

    for (const expected of [
      'Flight.id',
      'Flight.status',
      'Flight.dep_code',
      'Airport.code',
      'Aircraft.id',
      'Crew.id',
      'Decision.id',
    ]) {
      expect(have, `missing index on ${expected}`).toContain(expected)
    }
  })

  it('A1 — unique constraints are OPERATIONAL', async () => {
    const rows = await run<{ label: string; status: string }>(
      session.graph,
      'CALL db.constraints() YIELD label, status RETURN label, status',
    )
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      expect(String(row.status).toUpperCase()).toBe('OPERATIONAL')
    }
  })

  it('A1 — a duplicate Flight.id is rejected', async () => {
    await reseed(session)

    const existing = (
      await run<{ id: string }>(session.graph, 'MATCH (f:Flight) RETURN f.id AS id LIMIT 1')
    )[0]
    expect(existing).toBeDefined()

    await expect(
      run(session.graph, 'CREATE (f:Flight {id: $id, status: "SCHEDULED"})', {
        id: existing!.id,
      }),
    ).rejects.toThrow()
  })

  it('the revision counter starts at zero after a reseed', async () => {
    await reseed(session)
    const row = (
      await run<{ n: number }>(session.graph, 'MATCH (m:Meta {id:"rev"}) RETURN m.n AS n')
    )[0]
    expect(Number(row?.n)).toBe(0)
  })
})
