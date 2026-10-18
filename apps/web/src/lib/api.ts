/**
 * The UI's only link to the backend.
 *
 * The web app computes nothing. It renders what the API returned, and the API
 * returns what the graph returned. If a number appears on screen, it came from
 * a Cypher result — that chain is the point.
 *
 * A failed request is surfaced, never swallowed into a default or a zero.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      cache: 'no-store',
    })
  } catch (err) {
    throw new ApiError(
      'UNREACHABLE',
      `Cannot reach the API at ${BASE}. Is \`pnpm dev:api\` running?`,
      0,
    )
  }

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    const error = body?.error
    throw new ApiError(
      error?.code ?? 'UNKNOWN',
      error?.message ?? `${res.status} ${res.statusText}`,
      res.status,
    )
  }
  return body as T
}

/* ------------------------------------------------------------------ */

export interface NetworkState {
  flights: number
  aircraft: number
  crew: number
  airports: number
  revision: number
}

export interface AffectedFlight {
  flight: string
  no: string
  dep: string
  arr: string
  delay: number
  pax: number
}

export interface EvidencePath {
  chain: string[]
  hop_types: string[]
  slack_at_each_hop: number[]
  hops: number
}

export interface FragileHandoff {
  from_flight: string
  to_flight: string
  kind: string
  slack_min: number
  blast_radius: number
  pax_at_risk: number
}

export interface Score {
  cancelled_flights: number
  pax_cancelled: number
  pax_delayed: number
  total_delay_minutes: number
  worst_delay: number
  score: number
}

export interface Violation {
  invariant: string
  message: string
  rows: Array<Record<string, unknown>>
}

export interface Evaluation {
  plan: { id: string; actions: Array<Record<string, unknown>> }
  verified: boolean
  violations: Violation[]
  score: Score
}

export interface FlightNode {
  id: string
  no: string
  dep: string
  arr: string
  sched_dep: number
  sched_arr: number
  delay: number
  status: string
  tail: string
  crew: string
  pax: number
}

export interface HandoffEdge {
  source: string
  target: string
  kind: 'NEXT_LEG' | 'CREW_NEXT'
  slack_min: number
  sched_ground: number
}

export interface CascadeFrame {
  wave: number
  changed: number
  delays: Record<string, number>
  cancelled: string[]
}

export interface CascadeReplay {
  graph: { nodes: FlightNode[]; edges: HandoffEdge[] }
  frames: CascadeFrame[]
  seeded: number
}

export const api = {
  replay: (disruptionId: string) =>
    request<CascadeReplay>('/api/network/replay', {
      method: 'POST',
      body: JSON.stringify({ disruption_id: disruptionId }),
    }),

  graph: () => request<{ nodes: FlightNode[]; edges: HandoffEdge[] }>('/api/network/graph'),

  state: () => request<{ flights: number; aircraft: number; crew: number; airports: number; revision: number }>('/api/network/state'),

  traceCascade: (disruptionId: string) =>
    request<{ seeded: number; iterations: number; waves: number[]; affected: AffectedFlight[] }>(
      '/api/network/cascade',
      { method: 'POST', body: JSON.stringify({ disruption_id: disruptionId }) },
    ),

  readCascade: () => request<{ affected: AffectedFlight[] }>('/api/network/cascade'),

  evidence: (flightId: string, rootId: string) =>
    request<EvidencePath>(`/api/network/flights/${flightId}/evidence?root=${rootId}`),

  fragile: (limit = 12) => request<{ handoffs: FragileHandoff[] }>(`/api/analysis/fragile?limit=${limit}`),

  evaluateAll: (disruptionId: string) =>
    request<{ evaluations: Evaluation[]; best: Evaluation | null; decision_id: string | null }>(
      '/api/plans/evaluate',
      { method: 'POST', body: JSON.stringify({ disruption_id: disruptionId }) },
    ),

  commit: (decisionId: string, disruptionId: string) =>
    request<{ id: string; new_rev: number; before: Score; after: Score }>(
      `/api/plans/${decisionId}/commit`,
      { method: 'POST', body: JSON.stringify({ disruption_id: disruptionId }) },
    ),

  stress: (airportCode: string, impactMin: number) =>
    request<{
      affected: number
      worst_delay: number
      breakages: Violation[]
      missing_slack: Array<{
        from_flight: string
        to_flight: string
        kind: string
        slack_min: number
        slack_short_by: number
        pax_affected: number
      }>
    }>('/api/analysis/stress', {
      method: 'POST',
      body: JSON.stringify({ airport_code: airportCode, impact_min: impactMin }),
    }),
}

/** Airport coordinates, used only to draw the map. Public reference data. */
export const AIRPORTS: Record<string, { lat: number; lon: number; city: string }> = {
  DEL: { lat: 28.5562, lon: 77.1, city: 'Delhi' },
  BOM: { lat: 19.0896, lon: 72.8656, city: 'Mumbai' },
  BLR: { lat: 13.1986, lon: 77.7066, city: 'Bengaluru' },
  HYD: { lat: 17.2403, lon: 78.4294, city: 'Hyderabad' },
  MAA: { lat: 12.99, lon: 80.1693, city: 'Chennai' },
  CCU: { lat: 22.6547, lon: 88.4467, city: 'Kolkata' },
  PNQ: { lat: 18.5821, lon: 73.9197, city: 'Pune' },
  AMD: { lat: 23.0772, lon: 72.6347, city: 'Ahmedabad' },
  JAI: { lat: 26.8242, lon: 75.8122, city: 'Jaipur' },
  LKO: { lat: 26.7606, lon: 80.8893, city: 'Lucknow' },
  PAT: { lat: 25.591, lon: 85.088, city: 'Patna' },
}
