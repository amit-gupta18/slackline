/**
 * A11 — determinism, plus the structural guarantees the generator must give.
 *
 * These run WITHOUT FalkorDB: the generator is pure. The independent oracle
 * here re-checks the invariants in plain TypeScript — permitted precisely
 * because it lives in a test and never touches the decision path.
 */

import { describe, expect, it } from 'vitest'
import { generate } from '@slackline/graph'
import { DUTY_LIMIT_MIN, MIN_REST, MIN_TURN } from '@slackline/graph'
import type { Flight, Schedule } from '@slackline/shared'

const schedule = generate({ seed: 42 })
const byId = new Map(schedule.flights.map((f) => [f.id, f]))

describe('generator', () => {
  it('A11 — the same seed produces identical output', () => {
    expect(JSON.stringify(generate({ seed: 42 }))).toBe(JSON.stringify(generate({ seed: 42 })))
  })

  it('different seeds produce different schedules', () => {
    expect(JSON.stringify(generate({ seed: 42 }))).not.toBe(JSON.stringify(generate({ seed: 7 })))
  })

  it('produces the Phase 1 scale', () => {
    expect(schedule.flights.length).toBeGreaterThanOrEqual(40)
    expect(schedule.flights.length).toBeLessThanOrEqual(70)
    expect(schedule.airports).toHaveLength(11)
    expect(schedule.aircraft.filter((a) => a.is_spare)).toHaveLength(2)
    expect(schedule.crew.filter((c) => c.is_reserve)).toHaveLength(2)
  })

  it('every rotation starts and ends at the aircraft base (INV-3 holds at baseline)', () => {
    for (const aircraft of schedule.aircraft.filter((a) => !a.is_spare)) {
      const legs = legsOf(schedule, (f) => f.tail_id === aircraft.id)
      expect(legs.length).toBeGreaterThan(0)
      expect(legs[0]!.dep_code).toBe(aircraft.base)
      expect(legs.at(-1)!.arr_code).toBe(aircraft.base)

      for (let i = 0; i + 1 < legs.length; i++) {
        // The aircraft cannot teleport between consecutive legs.
        expect(legs[i]!.arr_code).toBe(legs[i + 1]!.dep_code)
        expect(legs[i + 1]!.sched_dep).toBeGreaterThanOrEqual(legs[i]!.sched_arr)
      }
    }
  })

  it('no crew exceeds the duty limit at baseline (INV-1 holds)', () => {
    for (const crew of schedule.crew.filter((c) => !c.is_reserve)) {
      const legs = legsOf(schedule, (f) => f.crew_id === crew.id)
      expect(legs.length).toBeGreaterThan(0)
      const span = legs.at(-1)!.sched_arr - legs[0]!.sched_dep
      expect(span).toBeLessThanOrEqual(DUTY_LIMIT_MIN)
    }
  })

  it('no hand-off is shorter than its minimum gap (INV-2 holds)', () => {
    for (const link of schedule.nextLeg) {
      expect(ground(link)).toBeGreaterThanOrEqual(MIN_TURN)
    }
    for (const link of schedule.crewNext) {
      expect(ground(link)).toBeGreaterThanOrEqual(MIN_REST)
    }
  })

  it('edge sched_ground always matches the flights it connects', () => {
    for (const link of [...schedule.nextLeg, ...schedule.crewNext]) {
      expect(link.sched_ground).toBe(ground(link))
    }
  })

  it('every flight fits the operating day and is internally consistent', () => {
    for (const flight of schedule.flights) {
      expect(flight.sched_dep).toBeGreaterThanOrEqual(300)
      expect(flight.sched_arr).toBeLessThanOrEqual(1380)
      expect(flight.sched_arr).toBeGreaterThan(flight.sched_dep)
      expect(flight.dep_code).not.toBe(flight.arr_code)
      expect(flight.pax).toBeLessThanOrEqual(flight.seats)
      expect(flight.crew_id).not.toBe('')
    }
  })

  it('plants thin hand-offs so a cascade is guaranteed to propagate', () => {
    expect(schedule.thinHandoffs.length).toBeGreaterThanOrEqual(2)
    for (const thin of schedule.thinHandoffs) {
      expect(thin.slack_min).toBeLessThanOrEqual(10)
      expect(thin.slack_min).toBeGreaterThanOrEqual(0)
    }
  })

  it('reports thin hand-offs that really exist with that slack', () => {
    for (const thin of schedule.thinHandoffs) {
      const pool = thin.kind === 'NEXT_LEG' ? schedule.nextLeg : schedule.crewNext
      const link = pool.find((l) => l.from === thin.from && l.to === thin.to)
      expect(link, `${thin.kind} ${thin.from}->${thin.to} is not a real edge`).toBeDefined()
      expect(link!.sched_ground - link!.min_gap).toBe(thin.slack_min)
    }
  })
})

function legsOf(schedule: Schedule, predicate: (f: Flight) => boolean): Flight[] {
  return schedule.flights.filter(predicate).sort((a, b) => a.sched_dep - b.sched_dep)
}

function ground(link: { from: string; to: string; sched_ground: number; min_gap: number }): number {
  const from = byId.get(link.from)
  const to = byId.get(link.to)
  if (!from || !to) throw new Error(`dangling hand-off ${link.from}->${link.to}`)
  return to.sched_dep - from.sched_arr
}
