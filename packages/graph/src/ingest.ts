/**
 * Idempotent loader. Every statement is MERGE-based and batched with UNWIND,
 * so re-running `pnpm seed` over an existing graph converges rather than
 * duplicating.
 */

import type { Schedule } from '@slackline/shared'
import { run, type Graph } from './db.js'
import {
  INGEST_AIRCRAFT,
  INGEST_AIRPORTS,
  INGEST_ASSIGNED_TO,
  INGEST_CREW,
  INGEST_CREW_NEXT,
  INGEST_DISRUPTIONS,
  INGEST_FLIGHTS,
  INGEST_FLIGHT_AIRPORT_EDGES,
  INGEST_NEXT_LEG,
  INGEST_OPERATES,
} from './queries.js'

/** Round-trip latency dominates against a hosted instance — batch generously. */
const BATCH_SIZE = 500

export interface IngestCounts {
  airports: number
  aircraft: number
  crew: number
  flights: number
  nextLeg: number
  crewNext: number
  disruptions: number
}

export async function ingest(graph: Graph, schedule: Schedule): Promise<IngestCounts> {
  const airports = await batched(graph, INGEST_AIRPORTS, 'rows', schedule.airports)
  const aircraft = await batched(graph, INGEST_AIRCRAFT, 'rows', schedule.aircraft)
  const crew = await batched(graph, INGEST_CREW, 'rows', schedule.crew)
  const flights = await batched(graph, INGEST_FLIGHTS, 'rows', schedule.flights)

  // Edges depend on the nodes above already existing.
  await batched(graph, INGEST_FLIGHT_AIRPORT_EDGES, 'rows', schedule.flights)
  await batched(graph, INGEST_OPERATES, 'rows', schedule.flights)
  await batched(graph, INGEST_ASSIGNED_TO, 'rows', schedule.flights)

  const nextLeg = await batched(graph, INGEST_NEXT_LEG, 'links', schedule.nextLeg)
  const crewNext = await batched(graph, INGEST_CREW_NEXT, 'links', schedule.crewNext)
  const disruptions = await batched(graph, INGEST_DISRUPTIONS, 'rows', schedule.disruptions)

  return { airports, aircraft, crew, flights, nextLeg, crewNext, disruptions }
}

async function batched<T>(
  graph: Graph,
  query: string,
  paramName: 'rows' | 'links',
  items: readonly T[],
): Promise<number> {
  let total = 0
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE)
    const rows = await run<{ n: number }>(graph, query, { [paramName]: slice })
    total += Number(rows[0]?.n ?? 0)
  }
  return total
}
