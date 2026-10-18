/**
 * Passenger recovery — algo.maxFlow used for its actual purpose.
 *
 * Seats are capacities. Passengers are flow. The question "how many of these
 * stranded passengers can physically be moved?" is a max-flow problem over a
 * graph of remaining seats, and "how do they get there?" is a shortest-path
 * problem over elapsed time.
 *
 * The CAN_CARRY subgraph is derived state, so it is always built on a fork and
 * thrown away (docs/kickoff.md §11).
 */

import type { FalkorDB } from 'falkordb'
import { run, withFork, type Graph } from './db.js'
import { BUILD_CAN_CARRY, REROUTE_CAPACITY, REROUTE_ITINERARIES } from './queries.js'

export interface Itinerary {
  route: string[]
  total_minutes: number
  connections: number
}

export interface RecoveryResult {
  origin: string
  destination: string
  after_min: number
  /** Seats reachable end-to-end — the max-flow value. */
  reroutable_seats: number
  flights_used: number
  itineraries: Itinerary[]
  /** True when the engine does not provide the algo.* procedures. */
  unavailable?: string
}

/**
 * How many stranded passengers can be rerouted, and by what itineraries.
 *
 * `after_min` is normally the disrupted flight's projected arrival: only
 * flights departing after that can carry its passengers onward.
 */
export async function reroutePassengers(
  db: FalkorDB,
  liveName: string,
  params: { origin: string; destination: string; afterMin: number; maxItineraries?: number },
): Promise<RecoveryResult> {
  const { origin, destination, afterMin } = params

  return withFork(db, liveName, async (sim) => {
    await run(sim, BUILD_CAN_CARRY, { after_min: afterMin })

    try {
      const capacity = (
        await run<{ reroutable_seats: number; flights_used: number }>(sim, REROUTE_CAPACITY, {
          origin,
          destination,
        })
      )[0]

      const itineraries = await readItineraries(sim, origin, destination)

      return {
        origin,
        destination,
        after_min: afterMin,
        reroutable_seats: Number(capacity?.reroutable_seats ?? 0),
        flights_used: Number(capacity?.flights_used ?? 0),
        itineraries,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A missing procedure is a capability gap on the engine, not a failure of
      // the product. Report it honestly rather than returning a fabricated zero.
      if (/unknown procedure|not registered/i.test(message)) {
        return {
          origin,
          destination,
          after_min: afterMin,
          reroutable_seats: 0,
          flights_used: 0,
          itineraries: [],
          unavailable: `this FalkorDB build does not provide the algo.* procedures: ${message}`,
        }
      }
      throw err
    }
  })
}

async function readItineraries(
  graph: Graph,
  origin: string,
  destination: string,
): Promise<Itinerary[]> {
  const rows = await run<Itinerary>(graph, REROUTE_ITINERARIES, { origin, destination })
  return rows.map((r) => ({
    route: (r.route ?? []).map(String),
    total_minutes: Number(r.total_minutes),
    connections: Number(r.connections),
  }))
}
