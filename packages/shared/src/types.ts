/**
 * Shared types. Imported by packages/graph, apps/api and apps/web so that
 * every layer speaks the same shape. No logic lives here.
 *
 * All times are integer minutes from 00:00 of the operating day.
 */

export type FlightStatus = 'SCHEDULED' | 'CANCELLED'

export type DisruptionKind = 'FOG' | 'ATC' | 'TECH' | 'RULE_CHANGE'

export type DecisionStatus = 'PROPOSED' | 'VERIFIED' | 'REJECTED' | 'COMMITTED'

export interface Airport {
  code: string
  name: string
  city: string
  lat: number
  lon: number
}

export interface Flight {
  id: string
  flight_no: string
  dep_code: string
  arr_code: string
  sched_dep: number
  sched_arr: number
  pax: number
  seats: number
  tail_id: string
  crew_id: string
}

export interface Aircraft {
  id: string
  type: string
  base: string
  is_spare: boolean
}

export interface Crew {
  id: string
  name: string
  base: string
  duty_start: number
  duty_limit_min: number
  is_reserve: boolean
}

export interface Disruption {
  id: string
  kind: DisruptionKind
  airport_code: string
  start_min: number
  end_min: number
  impact_min: number
}

/** A hand-off edge: NEXT_LEG (same aircraft) or CREW_NEXT (same crew). */
export interface HandoffLink {
  from: string
  to: string
  /** min_turn for NEXT_LEG, min_rest for CREW_NEXT. */
  min_gap: number
  sched_ground: number
}

export interface Schedule {
  airports: Airport[]
  aircraft: Aircraft[]
  crew: Crew[]
  flights: Flight[]
  nextLeg: HandoffLink[]
  crewNext: HandoffLink[]
  disruptions: Disruption[]
  /** Hand-offs the generator deliberately made thin (slack_min <= 10). */
  thinHandoffs: Array<{ from: string; to: string; slack_min: number; kind: 'NEXT_LEG' | 'CREW_NEXT' }>
}

/* ------------------------------------------------------------------ */
/* Cascade                                                             */
/* ------------------------------------------------------------------ */

export interface AffectedFlight {
  flight: string
  no: string
  dep: string
  arr: string
  delay: number
  pax: number
}

export interface CascadeResult {
  seeded: number
  iterations: number
  /** Flights changed per relaxation wave; the last entry is always 0. */
  waves: number[]
  affected: AffectedFlight[]
}

export interface EvidencePath {
  chain: string[]
  hop_types: Array<'NEXT_LEG' | 'CREW_NEXT'>
  slack_at_each_hop: number[]
  hops: number
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

/**
 * The fixed action menu. A plan cannot contain anything outside this union —
 * that is the structural guarantee that no action can be invented (AGENTS.md 3.4).
 */
export type Action =
  | { type: 'CANCEL_PAIR'; legs: [string, string] }
  | { type: 'SWAP_TAIL'; flight: string; to_aircraft: string }
  | { type: 'SWAP_CREW'; flight: string; to_crew: string }
  | { type: 'ABSORB'; flight: string }

export interface Plan {
  id: string
  actions: Action[]
}

export interface Violation {
  invariant: 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4'
  message: string
  rows: Array<Record<string, unknown>>
}

export interface Score {
  cancelled_flights: number
  pax_cancelled: number
  /** Headcount on flights delayed beyond the significance threshold. */
  pax_delayed: number
  /** Passengers × minutes of delay — the severity-weighted measure. */
  pax_delay_minutes: number
  total_delay_minutes: number
  worst_delay: number
  /** pax_cancelled*3 + (pax_delay_minutes/60)*1 — a declared heuristic. */
  score: number
}

export interface Evaluation {
  plan: Plan
  verified: boolean
  violations: Violation[]
  score: Score
}

export interface CandidateSet {
  cancelPairs: Array<{ leg_out: string; leg_back: string; pax_cost: number; delay_at_root: number }>
  spareTails: Array<{ flight: string; aircraft: string; station: string }>
  reserveCrew: Array<{ flight: string; crew: string; slack_left: number }>
}

export interface DecisionRecord {
  id: string
  created_at: string
  cascade_root: string
  plan: Plan
  score: Score
  graph_rev: number
  status: DecisionStatus
}

export interface Receipt {
  id: string
  decision_id: string
  applied_at: string
  before: Score
  after: Score
  new_rev: number
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown }
}
