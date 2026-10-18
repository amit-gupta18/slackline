/**
 * Synthetic schedule generator.
 *
 * Hackathon Rule 6: every flight number, tail, crew member and passenger count
 * below is generated. Only the airport codes and coordinates are public data.
 * No real airline schedule is used anywhere in this project.
 *
 * Fully seeded — two runs with the same seed produce byte-identical output
 * (acceptance test A11). Math.random() is never used.
 */

import type {
  Aircraft,
  Airport,
  Crew,
  Disruption,
  Flight,
  HandoffLink,
  Schedule,
} from '@slackline/shared'
import { DUTY_LIMIT_MIN, MIN_REST, MIN_TURN } from './config.js'

/* ------------------------------------------------------------------ */
/* Seeded PRNG — mulberry32. Deterministic, 20 lines, no dependency.   */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rng {
  constructor(private readonly next: () => number) {}
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)]
    if (item === undefined) throw new Error('pick() from an empty list')
    return item
  }
}

/* ------------------------------------------------------------------ */
/* Public airport data                                                 */
/* ------------------------------------------------------------------ */

const AIRPORTS: Airport[] = [
  { code: 'DEL', name: 'Indira Gandhi Intl', city: 'Delhi', lat: 28.5562, lon: 77.1 },
  { code: 'BOM', name: 'Chhatrapati Shivaji Maharaj Intl', city: 'Mumbai', lat: 19.0896, lon: 72.8656 },
  { code: 'BLR', name: 'Kempegowda Intl', city: 'Bengaluru', lat: 13.1986, lon: 77.7066 },
  { code: 'HYD', name: 'Rajiv Gandhi Intl', city: 'Hyderabad', lat: 17.2403, lon: 78.4294 },
  { code: 'MAA', name: 'Chennai Intl', city: 'Chennai', lat: 12.99, lon: 80.1693 },
  { code: 'CCU', name: 'Netaji Subhas Chandra Bose Intl', city: 'Kolkata', lat: 22.6547, lon: 88.4467 },
  { code: 'PNQ', name: 'Pune', city: 'Pune', lat: 18.5821, lon: 73.9197 },
  { code: 'AMD', name: 'Sardar Vallabhbhai Patel Intl', city: 'Ahmedabad', lat: 23.0772, lon: 72.6347 },
  { code: 'JAI', name: 'Jaipur Intl', city: 'Jaipur', lat: 26.8242, lon: 75.8122 },
  { code: 'LKO', name: 'Chaudhary Charan Singh Intl', city: 'Lucknow', lat: 26.7606, lon: 80.8893 },
  { code: 'PAT', name: 'Jay Prakash Narayan Intl', city: 'Patna', lat: 25.591, lon: 85.088 },
]

const AIRPORT_BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]))

/** Great-circle distance in km. */
function distanceKm(from: string, to: string): number {
  const a = AIRPORT_BY_CODE.get(from)
  const b = AIRPORT_BY_CODE.get(to)
  if (!a || !b) throw new Error(`unknown airport: ${from} / ${to}`)
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Block time in minutes.
 *
 * DECLARED SIMPLIFICATION: a linear function of great-circle distance, clamped
 * to 50-120 minutes so that a 4-6 leg rotation fits inside one operating day.
 * Real block times vary with routing, winds and taxi time.
 */
function blockTime(from: string, to: string): number {
  const raw = Math.round(distanceKm(from, to) / 15) + 20
  return Math.min(120, Math.max(50, raw))
}

/* ------------------------------------------------------------------ */
/* Generator parameters                                                */
/* ------------------------------------------------------------------ */

export interface GenerateOptions {
  seed?: number
  operatingAircraft?: number
  spareAircraft?: number
  reserveCrew?: number
  /** Number of hand-offs deliberately made thin (slack_min <= 10). */
  thinHandoffs?: number
}

const DAY_START = 300 // 05:00
const DAY_END = 1380 // 23:00
const SEATS = 186
/**
 * Aircraft bases, weighted towards DEL.
 *
 * A carrier concentrates aircraft at its hubs, and the default disruption is
 * fog at DEL — with bases spread evenly across eleven airports, barely any
 * flights departed DEL inside the fog window and the cascade had nothing to
 * propagate through.
 */
const AIRCRAFT_BASES = ['DEL', 'DEL', 'DEL', 'DEL', 'BOM', 'BOM', 'BOM', 'BLR', 'BLR', 'HYD']
const SPARE_BASES = ['DEL', 'BOM']
const RESERVE_BASES = ['DEL', 'BLR']

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export function generate(options: GenerateOptions = {}): Schedule {
  const {
    seed = 42,
    operatingAircraft = 10,
    spareAircraft = 2,
    reserveCrew = 2,
    thinHandoffs = 3,
  } = options

  const rng = new Rng(mulberry32(seed))

  const aircraft: Aircraft[] = []
  const flights: Flight[] = []
  const nextLeg: HandoffLink[] = []
  const thin: Schedule['thinHandoffs'] = []

  /** Rotations, kept so crew can be laid over them afterwards. */
  const rotations: Flight[][] = []

  let flightSeq = 100

  for (let i = 0; i < operatingAircraft; i++) {
    const tailId = `VT-A${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`
    const base = AIRCRAFT_BASES[i] ?? 'DEL'
    aircraft.push({ id: tailId, type: 'A320', base, is_spare: false })

    // Build the route and its timings first, so the rotation can be placed in
    // the day only once it is known to fit inside it.
    // Even, so the rotation is a whole number of out-and-back pairs: 4 or 6.
    const legCount = rng.int(2, 3) * 2
    const route = buildRoute(rng, base, legCount)
    const blocks = route.map((leg) => blockTime(leg.from, leg.to))
    const grounds = route.slice(0, -1).map(() => rng.int(MIN_TURN + 5, MIN_TURN + 50)) // 45-90
    const span = sum(blocks) + sum(grounds)

    // Latest start that still lands the last leg before the day ends.
    const latestStart = DAY_END - span
    if (latestStart < DAY_START) {
      throw new Error(
        `rotation for ${tailId} spans ${span} min and cannot fit the ${DAY_START}-${DAY_END} day`,
      )
    }
    let clock = Math.min(rng.int(DAY_START, DAY_START + 120), latestStart)

    const rotation: Flight[] = []
    for (let leg = 0; leg < route.length; leg++) {
      const { from, to } = route[leg]!
      const dep = clock
      const arr = dep + blocks[leg]!

      flightSeq++
      const flight: Flight = {
        id: `6E${flightSeq}`,
        flight_no: `6E ${flightSeq}`,
        dep_code: from,
        arr_code: to,
        sched_dep: dep,
        sched_arr: arr,
        pax: rng.int(110, SEATS),
        seats: SEATS,
        tail_id: tailId,
        crew_id: '', // assigned below
      }
      rotation.push(flight)
      flights.push(flight)

      const ground = grounds[leg]
      if (ground !== undefined) clock = arr + ground
    }

    rotations.push(rotation)
  }

  // Aircraft hand-off edges, derived from the rotations themselves.
  for (const rotation of rotations) {
    for (let i = 0; i + 1 < rotation.length; i++) {
      const a = rotation[i]!
      const b = rotation[i + 1]!
      nextLeg.push({
        from: a.id,
        to: b.id,
        min_gap: MIN_TURN,
        sched_ground: b.sched_dep - a.sched_arr,
      })
    }
  }

  // Deliberately plant thin hand-offs so a cascade is guaranteed to propagate.
  // Tightening a turn pulls every later leg of that rotation earlier, so the
  // rotation is re-timed in place and its edges recomputed.
  plantThinHandoffs(rng, rotations, nextLeg, thinHandoffs)

  // Crew: consecutive legs of one rotation, split so no duty window exceeds
  // the limit at baseline (otherwise INV-1 would fail before anything happens).
  const { crew, crewNext } = assignCrew(rotations)

  // Report the thin hand-offs truthfully, from the edges as they actually
  // ended up, rather than from what the planting intended. The stress-test
  // mode is validated against this list, so it must not drift.
  thin.push(...collectThinHandoffs(nextLeg, 'NEXT_LEG'), ...collectThinHandoffs(crewNext, 'CREW_NEXT'))
  thin.sort((a, b) => a.slack_min - b.slack_min || a.from.localeCompare(b.from))

  for (let i = 0; i < spareAircraft; i++) {
    aircraft.push({
      id: `VT-SP${String.fromCharCode(65 + i)}`,
      type: 'A320',
      base: SPARE_BASES[i] ?? 'DEL',
      is_spare: true,
    })
  }

  for (let i = 0; i < reserveCrew; i++) {
    crew.push({
      id: `CR-R${i + 1}`,
      name: `Reserve Crew ${i + 1}`,
      base: RESERVE_BASES[i] ?? 'DEL',
      duty_start: DAY_START,
      duty_limit_min: DUTY_LIMIT_MIN,
      is_reserve: true,
    })
  }

  const disruptions: Disruption[] = [
    {
      id: 'disruption-fog-del',
      kind: 'FOG',
      airport_code: 'DEL',
      start_min: 300, // 05:00 — covers the full morning departure bank
      end_min: 570, // 09:30
      impact_min: 120,
    },
  ]

  return {
    airports: AIRPORTS,
    aircraft,
    crew,
    flights,
    nextLeg,
    crewNext,
    disruptions,
    thinHandoffs: thin,
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0)
}

/**
 * Build a closed route of `legCount` legs starting and ending at `base`.
 *
 * Hub pattern: consecutive out-and-back pairs from the aircraft's base
 * (DEL-BOM-DEL-BLR-DEL). This is how a short-haul hub carrier actually flies,
 * and it has two properties the product depends on:
 *
 *  - Tail continuity (INV-3) holds by construction before any plan touches it.
 *  - Every rotation contains out-and-back PAIRS, which are the only legal unit
 *    of cancellation. A route of unrelated hops generates almost no cancellable
 *    pairs, leaving the planner with nothing to propose but "do nothing".
 *
 * `legCount` must be even.
 */
function buildRoute(rng: Rng, base: string, legCount: number): Array<{ from: string; to: string }> {
  const route: Array<{ from: string; to: string }> = []
  let previous: string | null = null

  for (let pair = 0; pair < legCount / 2; pair++) {
    const outstation = pickDestination(rng, base, previous)
    route.push({ from: base, to: outstation })
    route.push({ from: outstation, to: base })
    previous = outstation
  }
  return route
}

/**
 * Choose an outstation: never the base itself, and never the same airport twice
 * in a row (an aircraft turning straight back round to where it just came from
 * reads as a generator artefact).
 */
function pickDestination(rng: Rng, base: string, previous: string | null): string {
  const candidates = AIRPORTS.map((a) => a.code).filter(
    (code) => code !== base && code !== previous,
  )
  return rng.pick(candidates)
}

/**
 * Tighten `count` aircraft hand-offs to slack_min <= 10 and re-time the rest of
 * the rotation to match. These planted thin turns are what guarantee the
 * cascade propagates, and the stress-test mode is validated against this list.
 */
function plantThinHandoffs(
  rng: Rng,
  rotations: Flight[][],
  nextLeg: HandoffLink[],
  count: number,
): void {
  const usableRotations = rotations.filter((r) => r.length >= 3)

  for (let i = 0; i < count && i < usableRotations.length; i++) {
    const rotation = usableRotations[i]!
    const index = rng.int(0, rotation.length - 2)
    const a = rotation[index]!
    const b = rotation[index + 1]!

    // Floor the tightened turn at the LARGER of min_turn and min_rest. The same
    // pair of legs may carry both a NEXT_LEG and a CREW_NEXT edge, and crew rest
    // is the longer requirement — tightening to min_turn alone would generate a
    // schedule whose crew rest was already illegal before any disruption.
    const floor = Math.max(MIN_TURN, MIN_REST)
    const tightGround = rng.int(floor, floor + 10)
    const shift = b.sched_dep - (a.sched_arr + tightGround)
    if (shift <= 0) continue

    // Pull this leg and every later leg of the rotation earlier by `shift`.
    for (let j = index + 1; j < rotation.length; j++) {
      const leg = rotation[j]!
      leg.sched_dep -= shift
      leg.sched_arr -= shift
    }
  }

  // Final pass: every ground time is recomputed from the (re-timed) flights,
  // so the edge data can never drift out of step with the schedule.
  for (const link of nextLeg) {
    const from = findFlight(rotations, link.from)
    const to = findFlight(rotations, link.to)
    link.sched_ground = to.sched_dep - from.sched_arr
  }
}

/** Every hand-off whose slack is 10 minutes or less — the fragile ones. */
function collectThinHandoffs(
  links: readonly HandoffLink[],
  kind: 'NEXT_LEG' | 'CREW_NEXT',
): Schedule['thinHandoffs'] {
  return links
    .map((l) => ({ from: l.from, to: l.to, slack_min: l.sched_ground - l.min_gap, kind }))
    .filter((t) => t.slack_min <= 10)
}

function findFlight(rotations: Flight[][], id: string): Flight {
  for (const rotation of rotations) {
    for (const flight of rotation) if (flight.id === id) return flight
  }
  throw new Error(`flight not found in any rotation: ${id}`)
}

/**
 * Lay crew over the aircraft rotations.
 *
 * A crew member covers consecutive legs of ONE rotation. Chunks are split so
 * that (last_arr - first_dep) <= DUTY_LIMIT_MIN at baseline — if the generator
 * emitted a schedule that already violated INV-1, no plan could ever verify.
 */
function assignCrew(rotations: Flight[][]): { crew: Crew[]; crewNext: HandoffLink[] } {
  const crew: Crew[] = []
  const crewNext: HandoffLink[] = []
  let crewSeq = 0

  for (const rotation of rotations) {
    let chunk: Flight[] = []

    const flush = () => {
      if (chunk.length === 0) return
      crewSeq++
      const id = `CR-${String(crewSeq).padStart(2, '0')}`
      const first = chunk[0]!
      for (const leg of chunk) leg.crew_id = id
      crew.push({
        id,
        name: `Crew ${crewSeq}`,
        base: first.dep_code,
        duty_start: first.sched_dep - 60, // report 60 min before first departure
        duty_limit_min: DUTY_LIMIT_MIN,
        is_reserve: false,
      })
      for (let i = 0; i + 1 < chunk.length; i++) {
        const a = chunk[i]!
        const b = chunk[i + 1]!
        crewNext.push({
          from: a.id,
          to: b.id,
          min_gap: MIN_REST,
          sched_ground: b.sched_dep - a.sched_arr,
        })
      }
      chunk = []
    }

    for (const leg of rotation) {
      const span = chunk.length === 0 ? 0 : leg.sched_arr - chunk[0]!.sched_dep
      // Start a new crew when the duty window would be exceeded, or after 5 legs.
      if (chunk.length >= 5 || (chunk.length > 0 && span > DUTY_LIMIT_MIN)) flush()
      chunk.push(leg)
    }
    flush()
  }

  return { crew, crewNext }
}

/**
 * A crew hand-off is only a real dependency when the crew physically stays with
 * the same aircraft, which is how `assignCrew` builds them. The min_rest gap on
 * a CREW_NEXT edge is therefore usually larger than the aircraft's min_turn —
 * crew slack is tighter than tail slack, which is exactly the fragility this
 * project is about.
 */
export const GENERATOR_NOTES = {
  simplifications: [
    'Block time is a linear function of great-circle distance, clamped to 50-120 min.',
    'One duty rule (a single duty-window limit), not the full DGCA FDTL CAR.',
    'Single operating day, 05:00-23:00. No day-boundary handling.',
    'Deterministic delay arithmetic. No stochastic taxi, weather or ATC variation.',
    'Crew stay with one aircraft for their whole duty. No dead-heading.',
  ],
  dayWindow: { start: DAY_START, end: DAY_END },
} as const
