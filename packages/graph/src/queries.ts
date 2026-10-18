/**
 * EVERY Cypher statement in the product lives here, as a named constant.
 *
 * No inline Cypher anywhere else — not in a route, not in a script, not in a
 * test (AGENTS.md 3.7). This makes the README's "the Cypher queries the product
 * depends on" section a copy-paste, and makes hand-review tractable.
 *
 * All statements are parameterised. Never interpolate into these strings.
 */

/* ------------------------------------------------------------------ */
/* Schema — indexes and constraints                                    */
/* ------------------------------------------------------------------ */

export const INDEXES = [
  'CREATE INDEX FOR (n:Flight)   ON (n.id)',
  'CREATE INDEX FOR (n:Flight)   ON (n.status)',
  'CREATE INDEX FOR (n:Flight)   ON (n.dep_code)',
  'CREATE INDEX FOR (n:Airport)  ON (n.code)',
  'CREATE INDEX FOR (n:Aircraft) ON (n.id)',
  'CREATE INDEX FOR (n:Crew)     ON (n.id)',
  'CREATE INDEX FOR (n:Decision) ON (n.id)',
] as const

/** Unique constraints, applied after indexes exist and before ingest. */
export const UNIQUE_CONSTRAINTS = [
  { label: 'Flight', property: 'id' },
  { label: 'Airport', property: 'code' },
  { label: 'Aircraft', property: 'id' },
  { label: 'Crew', property: 'id' },
] as const

export const LIST_INDEXES = 'CALL db.indexes()'

export const WIPE_GRAPH = 'MATCH (n) DETACH DELETE n'

export const INIT_REVISION = 'MERGE (m:Meta {id:"rev"}) ON CREATE SET m.n = 0 RETURN m.n AS n'

/* ------------------------------------------------------------------ */
/* Ingest                                                              */
/* ------------------------------------------------------------------ */

export const INGEST_AIRPORTS = `
UNWIND $rows AS r
MERGE (a:Airport {code: r.code})
SET a.name = r.name, a.city = r.city, a.lat = r.lat, a.lon = r.lon
RETURN count(a) AS n
`

export const INGEST_AIRCRAFT = `
UNWIND $rows AS r
MERGE (ac:Aircraft {id: r.id})
SET ac.type = r.type, ac.base = r.base, ac.is_spare = r.is_spare
RETURN count(ac) AS n
`

export const INGEST_CREW = `
UNWIND $rows AS r
MERGE (c:Crew {id: r.id})
SET c.name = r.name, c.base = r.base, c.duty_start = r.duty_start,
    c.duty_limit_min = r.duty_limit_min, c.is_reserve = r.is_reserve
RETURN count(c) AS n
`

export const INGEST_FLIGHTS = `
UNWIND $rows AS r
MERGE (f:Flight {id: r.id})
SET f.flight_no = r.flight_no,
    f.dep_code  = r.dep_code,
    f.arr_code  = r.arr_code,
    f.sched_dep = r.sched_dep,
    f.sched_arr = r.sched_arr,
    f.proj_dep  = r.sched_dep,
    f.proj_arr  = r.sched_arr,
    f.delay_min = 0,
    f.pax       = r.pax,
    f.seats     = r.seats,
    f.status    = 'SCHEDULED',
    f.tail_id   = r.tail_id,
    f.crew_id   = r.crew_id
RETURN count(f) AS n
`

/** Flight -> Airport edges. Kept for traversal and for the Phase 3 map. */
export const INGEST_FLIGHT_AIRPORT_EDGES = `
UNWIND $rows AS r
MATCH (f:Flight {id: r.id})
MATCH (o:Airport {code: r.dep_code})
MATCH (d:Airport {code: r.arr_code})
MERGE (f)-[:DEPARTS_FROM]->(o)
MERGE (f)-[:ARRIVES_AT]->(d)
RETURN count(f) AS n
`

export const INGEST_OPERATES = `
UNWIND $rows AS r
MATCH (ac:Aircraft {id: r.tail_id})
MATCH (f:Flight {id: r.id})
MERGE (ac)-[:OPERATES]->(f)
RETURN count(f) AS n
`

export const INGEST_ASSIGNED_TO = `
UNWIND $rows AS r
MATCH (c:Crew {id: r.crew_id})
MATCH (f:Flight {id: r.id})
MERGE (c)-[:ASSIGNED_TO]->(f)
RETURN count(f) AS n
`

/**
 * The aircraft hand-off edge. slack_min = sched_ground - min_turn.
 * Slack is a property of the HAND-OFF, not of a flight — the modelling
 * insight of the whole project.
 */
export const INGEST_NEXT_LEG = `
UNWIND $links AS l
MATCH (a:Flight {id: l.from}), (b:Flight {id: l.to})
MERGE (a)-[e:NEXT_LEG]->(b)
SET e.min_turn     = l.min_gap,
    e.sched_ground = l.sched_ground,
    e.slack_min    = l.sched_ground - l.min_gap
RETURN count(e) AS n
`

/** The crew hand-off edge. slack_min = sched_ground - min_rest. */
export const INGEST_CREW_NEXT = `
UNWIND $links AS l
MATCH (a:Flight {id: l.from}), (b:Flight {id: l.to})
MERGE (a)-[e:CREW_NEXT]->(b)
SET e.min_rest     = l.min_gap,
    e.sched_ground = l.sched_ground,
    e.slack_min    = l.sched_ground - l.min_gap
RETURN count(e) AS n
`

export const INGEST_DISRUPTIONS = `
UNWIND $rows AS r
MERGE (d:Disruption {id: r.id})
SET d.kind = r.kind, d.airport_code = r.airport_code,
    d.start_min = r.start_min, d.end_min = r.end_min, d.impact_min = r.impact_min
WITH d, r
MATCH (a:Airport {code: r.airport_code})
MERGE (d)-[h:HITS]->(a)
SET h.impact_min = r.impact_min
RETURN count(d) AS n
`

/* ------------------------------------------------------------------ */
/* Cascade — the core graph computation                                */
/* ------------------------------------------------------------------ */

/** Apply the shock to every flight departing the hit airport inside the window. */
export const SEED_DISRUPTION = `
MATCH (d:Disruption {id: $disruption_id})
MATCH (f:Flight)
WHERE f.dep_code = d.airport_code
  AND f.sched_dep >= d.start_min
  AND f.sched_dep <= d.end_min
  AND f.status = 'SCHEDULED'
SET f.delay_min = d.impact_min,
    f.proj_dep  = f.sched_dep + d.impact_min,
    f.proj_arr  = f.sched_arr + d.impact_min
RETURN count(f) AS seeded
`

/**
 * One wave of propagation — Bellman-Ford over the hand-off edges.
 * Run repeatedly until it returns changed = 0.
 *
 * max() in the WITH is what makes a flight take the WORST of its inbound
 * aircraft delay and its inbound crew delay: a flight waits for both.
 *
 * `e` is named deliberately — FalkorDB only existence-checks unnamed
 * relationships, which would silently give wrong results here.
 */
export const RELAX_ONE_WAVE = `
MATCH (a:Flight)-[e:NEXT_LEG|CREW_NEXT]->(b:Flight)
WHERE a.status = 'SCHEDULED'
  AND b.status = 'SCHEDULED'
  AND (a.delay_min - e.slack_min) > b.delay_min
WITH b, max(a.delay_min - e.slack_min) AS new_delay
SET b.delay_min = new_delay,
    b.proj_dep  = b.sched_dep + new_delay,
    b.proj_arr  = b.sched_arr + new_delay
RETURN count(b) AS changed
`

/**
 * Clear all cascade state back to the published schedule.
 *
 * Relaxation is monotone — it only ever raises a delay — so a plan evaluated on
 * a fork must start from a clean schedule and re-propagate. Without this reset,
 * cancelling a flight could never reduce a delay that had already spread
 * downstream, and every plan would score identically.
 */
export const RESET_CASCADE = `
MATCH (f:Flight)
WHERE f.status = 'SCHEDULED'
SET f.delay_min = 0, f.proj_dep = f.sched_dep, f.proj_arr = f.sched_arr
RETURN count(f) AS reset
`

export const READ_CASCADE = `
MATCH (f:Flight)
WHERE f.delay_min > 0 AND f.status = 'SCHEDULED'
RETURN f.id AS flight, f.flight_no AS no, f.dep_code AS dep, f.arr_code AS arr,
       f.delay_min AS delay, f.pax AS pax
ORDER BY f.delay_min DESC, f.id
`

/**
 * "Why is this flight late?" — the literal chain of hand-offs from the root.
 * The most judge-friendly query in the project.
 */
export const EVIDENCE_PATH = `
MATCH p = (root:Flight {id: $root_id})-[:NEXT_LEG|CREW_NEXT*1..8]->(target:Flight {id: $target_id})
RETURN [n IN nodes(p) | n.id]                AS chain,
       [r IN relationships(p) | type(r)]     AS hop_types,
       [r IN relationships(p) | r.slack_min] AS slack_at_each_hop,
       length(p)                             AS hops
ORDER BY hops ASC
LIMIT 1
`

/* ------------------------------------------------------------------ */
/* Graph export — for drawing the dependency graph                     */
/* ------------------------------------------------------------------ */

/**
 * Every flight, with enough to lay it out: when it flies, which aircraft and
 * crew own it, and its current delay.
 */
export const EXPORT_FLIGHT_NODES = `
MATCH (f:Flight)
RETURN f.id AS id, f.flight_no AS no, f.dep_code AS dep, f.arr_code AS arr,
       f.sched_dep AS sched_dep, f.sched_arr AS sched_arr,
       f.delay_min AS delay, f.status AS status,
       f.tail_id AS tail, f.crew_id AS crew, f.pax AS pax
ORDER BY f.tail_id, f.sched_dep
`

/** The two hand-off edge types — the dependency structure itself. */
export const EXPORT_HANDOFF_EDGES = `
MATCH (a:Flight)-[e:NEXT_LEG|CREW_NEXT]->(b:Flight)
RETURN a.id AS source, b.id AS target, type(e) AS kind,
       e.slack_min AS slack_min, e.sched_ground AS sched_ground
ORDER BY source, target, kind
`

/** Just the delays — small payload, used for each animation frame. */
export const EXPORT_DELAYS = `
MATCH (f:Flight)
RETURN f.id AS id, f.delay_min AS delay, f.status AS status
ORDER BY f.id
`

/** Network counts for the demo header and GET /api/network/state. */
export const NETWORK_STATE = `
MATCH (f:Flight)
WITH count(f) AS flights
MATCH (ac:Aircraft) WITH flights, count(ac) AS aircraft
MATCH (c:Crew)      WITH flights, aircraft, count(c) AS crew
MATCH (a:Airport)   WITH flights, aircraft, crew, count(a) AS airports
MATCH (m:Meta {id:'rev'})
RETURN flights, aircraft, crew, airports, m.n AS revision
`

/* ------------------------------------------------------------------ */
/* The four invariants — each MUST return zero rows on a valid plan    */
/* ------------------------------------------------------------------ */

/** INV-1 — no crew exceeds its legal duty window. */
export const INV_1_DUTY = `
MATCH (c:Crew)-[:ASSIGNED_TO]->(f:Flight)
WHERE f.status = 'SCHEDULED'
WITH c, min(f.proj_dep) AS first_dep, max(f.proj_arr) AS last_arr
WHERE (last_arr - first_dep) > c.duty_limit_min
RETURN c.id AS crew, (last_arr - first_dep) AS duty_minutes, c.duty_limit_min AS duty_limit
ORDER BY crew
`

/** INV-2 — no aircraft turnaround is shorter than the minimum. */
export const INV_2_TURNAROUND = `
MATCH (a:Flight)-[e:NEXT_LEG]->(b:Flight)
WHERE a.status = 'SCHEDULED' AND b.status = 'SCHEDULED'
  AND (b.proj_dep - a.proj_arr) < e.min_turn
RETURN a.id AS from_flight, b.id AS to_flight,
       (b.proj_dep - a.proj_arr) AS actual_ground, e.min_turn AS required
ORDER BY from_flight, to_flight
`

/**
 * INV-3 — tail continuity. An aircraft cannot teleport.
 * This is why cancellations must be out-and-back PAIRS.
 *
 * TWO conditions, and the second is easy to miss:
 *
 *  (a) Between consecutive legs, the arrival airport must equal the next
 *      departure airport.
 *  (b) The FIRST remaining leg must depart from the aircraft's base — where it
 *      physically starts the day.
 *
 * Checking only (a) leaves a real hole. Cancel an aircraft's first leg of an
 * out-and-back and every surviving pair still chains correctly, but the
 * aircraft is now scheduled to depart from an outstation it never flew to.
 * Pairwise continuity is satisfied; the rotation is still impossible.
 */
export const INV_3_TAIL_CONTINUITY = `
MATCH (ac:Aircraft)-[:OPERATES]->(f:Flight)
WHERE f.status = 'SCHEDULED'
WITH ac, f ORDER BY f.proj_dep
WITH ac, collect(f) AS legs
UNWIND range(0, size(legs) - 2) AS i
WITH ac, legs[i] AS a, legs[i+1] AS b
WHERE a.arr_code <> b.dep_code
RETURN ac.id AS aircraft, a.id AS from_flight, a.arr_code AS lands_at,
       b.id AS to_flight, b.dep_code AS departs_from, 'BROKEN_CHAIN' AS reason
ORDER BY aircraft, from_flight
`

/** INV-3 part (b): the aircraft's first remaining leg must depart its base. */
export const INV_3_START_POSITION = `
MATCH (ac:Aircraft)-[:OPERATES]->(f:Flight)
WHERE f.status = 'SCHEDULED'
WITH ac, f ORDER BY f.proj_dep
WITH ac, collect(f) AS legs
WITH ac, legs[0] AS first
WHERE first.dep_code <> ac.base
RETURN ac.id AS aircraft, first.id AS from_flight, ac.base AS lands_at,
       first.id AS to_flight, first.dep_code AS departs_from,
       'STRANDED_START' AS reason
ORDER BY aircraft
`

/** INV-4 — every flight has a terminal status. */
export const INV_4_TERMINAL_STATUS = `
MATCH (f:Flight)
WHERE f.status IS NULL OR NOT f.status IN ['SCHEDULED', 'CANCELLED']
RETURN f.id AS flight, f.status AS status
ORDER BY flight
`

/* ------------------------------------------------------------------ */
/* Candidate actions — generated by the graph, never enumerated in TS  */
/* ------------------------------------------------------------------ */

export const CANDIDATES_CANCEL_PAIRS = `
MATCH (a:Flight)-[:NEXT_LEG]->(b:Flight)
WHERE a.status = 'SCHEDULED' AND b.status = 'SCHEDULED'
  AND a.dep_code = b.arr_code
  AND a.delay_min > $threshold
RETURN a.id AS leg_out, b.id AS leg_back,
       (a.pax + b.pax) AS pax_cost,
       a.delay_min AS delay_at_root
ORDER BY pax_cost ASC, leg_out
`

/**
 * Spare aircraft parked at the right station with no overlapping assignment.
 *
 * Written with OPTIONAL MATCH rather than EXISTS { } — the subquery form is
 * listed as unverified against the hosted build (docs/kickoff.md 16.4), and
 * this form is supported everywhere.
 */
export const CANDIDATES_SPARE_TAILS = `
MATCH (f:Flight {id: $flight_id})
MATCH (spare:Aircraft {is_spare: true})
WHERE spare.base = f.dep_code
OPTIONAL MATCH (spare)-[:OPERATES]->(x:Flight)
  WHERE x.status = 'SCHEDULED'
    AND x.proj_dep < f.proj_arr
    AND x.proj_arr > f.proj_dep
WITH spare, count(x) AS clashes
WHERE clashes = 0
RETURN spare.id AS aircraft, spare.base AS station
ORDER BY aircraft
`

/** Reserve crew with enough duty remaining and no overlapping assignment. */
export const CANDIDATES_RESERVE_CREW = `
MATCH (f:Flight {id: $flight_id})
MATCH (c:Crew {is_reserve: true})
WHERE c.base = f.dep_code
  AND (f.proj_arr - c.duty_start) <= c.duty_limit_min
OPTIONAL MATCH (c)-[:ASSIGNED_TO]->(x:Flight)
  WHERE x.status = 'SCHEDULED'
    AND x.proj_dep < f.proj_arr
    AND x.proj_arr > f.proj_dep
WITH c, f, count(x) AS clashes
WHERE clashes = 0
RETURN c.id AS crew, (c.duty_limit_min - (f.proj_arr - c.duty_start)) AS slack_left
ORDER BY slack_left DESC, crew
`

/** The worst-delayed flights, used to pick which flights to build plans around. */
export const WORST_DELAYED_FLIGHTS = `
MATCH (f:Flight)
WHERE f.status = 'SCHEDULED' AND f.delay_min > $threshold
RETURN f.id AS flight, f.delay_min AS delay, f.pax AS pax
ORDER BY f.delay_min DESC, f.id
LIMIT $limit
`

/* ------------------------------------------------------------------ */
/* Fragility — which hand-offs carry the most risk                     */
/* ------------------------------------------------------------------ */

/**
 * Rank hand-offs by how much of the network sits downstream of them.
 *
 * This is a descendant-count centrality over the dependency graph: for each
 * hand-off edge, how many flights are reachable from its downstream end, and
 * how many passengers are on them. Combined with the edge's slack, it answers
 * "where is this schedule actually fragile?" — thin slack in front of a large
 * blast radius.
 *
 * Deliberately NOT called betweenness: it is reachability, and claiming
 * otherwise would be an unsourced claim about our own method.
 */
export const RANK_FRAGILE_HANDOFFS = `
MATCH (a:Flight)-[e:NEXT_LEG|CREW_NEXT]->(b:Flight)
WHERE a.status = 'SCHEDULED' AND b.status = 'SCHEDULED'
OPTIONAL MATCH (b)-[:NEXT_LEG|CREW_NEXT*0..8]->(d:Flight)
WITH a, b, e, collect(DISTINCT d) AS downstream
WITH a, b, e,
     size(downstream) AS blast_radius,
     reduce(total = 0, f IN downstream | total + f.pax) AS pax_at_risk
RETURN a.id AS from_flight, b.id AS to_flight, type(e) AS kind,
       e.slack_min AS slack_min, blast_radius, pax_at_risk
ORDER BY slack_min ASC, pax_at_risk DESC, from_flight
LIMIT $limit
`

/* ------------------------------------------------------------------ */
/* Stress testing — where does the schedule break first                */
/* ------------------------------------------------------------------ */

/** Create an ad-hoc disruption on a fork, for a what-if scenario. */
export const CREATE_SCENARIO_DISRUPTION = `
MERGE (d:Disruption {id: $id})
SET d.kind = $kind, d.airport_code = $airport_code,
    d.start_min = $start_min, d.end_min = $end_min, d.impact_min = $impact_min
WITH d
MATCH (a:Airport {code: $airport_code})
MERGE (d)-[h:HITS]->(a)
SET h.impact_min = $impact_min
RETURN d.id AS id
`

/**
 * Hand-offs the cascade actually consumed: the delay arriving at `a` exceeded
 * the slack on the edge, so it spilled onto `b`. These are the links where the
 * schedule ran out of buffer, ranked by how much was missing.
 */
export const MISSING_SLACK_RANKING = `
MATCH (a:Flight)-[e:NEXT_LEG|CREW_NEXT]->(b:Flight)
WHERE a.status = 'SCHEDULED' AND b.status = 'SCHEDULED'
  AND a.delay_min > e.slack_min
RETURN a.id AS from_flight, b.id AS to_flight, type(e) AS kind,
       e.slack_min AS slack_min,
       a.delay_min AS inbound_delay,
       (a.delay_min - e.slack_min) AS slack_short_by,
       b.pax AS pax_affected
ORDER BY slack_short_by DESC, from_flight
LIMIT $limit
`

/* ------------------------------------------------------------------ */
/* Plan application — one mutation per action type                     */
/* ------------------------------------------------------------------ */

export const APPLY_CANCEL_PAIR = `
UNWIND $legs AS leg_id
MATCH (f:Flight {id: leg_id})
SET f.status = 'CANCELLED', f.delay_min = 0
RETURN count(f) AS cancelled
`

export const APPLY_SWAP_TAIL = `
MATCH (f:Flight {id: $flight_id})
MATCH (to:Aircraft {id: $to_aircraft})
OPTIONAL MATCH (old:Aircraft)-[r:OPERATES]->(f)
DELETE r
MERGE (to)-[:OPERATES]->(f)
SET f.tail_id = to.id
WITH f
MATCH (prev:Flight)-[e:NEXT_LEG]->(f)
DELETE e
RETURN f.id AS flight
`

export const APPLY_SWAP_CREW = `
MATCH (f:Flight {id: $flight_id})
MATCH (to:Crew {id: $to_crew})
OPTIONAL MATCH (old:Crew)-[r:ASSIGNED_TO]->(f)
DELETE r
MERGE (to)-[:ASSIGNED_TO]->(f)
SET f.crew_id = to.id
WITH f
MATCH (prev:Flight)-[e:CREW_NEXT]->(f)
DELETE e
RETURN f.id AS flight
`

/** ABSORB is a deliberate no-op: accept the delay as it stands. */
export const APPLY_ABSORB = `
MATCH (f:Flight {id: $flight_id})
RETURN f.id AS flight
`

/* ------------------------------------------------------------------ */
/* Scoring — every reported figure comes from this query               */
/* ------------------------------------------------------------------ */

export const SCORE_PLAN = `
MATCH (f:Flight)
WITH
  sum(CASE WHEN f.status = 'CANCELLED' THEN 1 ELSE 0 END)                             AS cancelled_flights,
  sum(CASE WHEN f.status = 'CANCELLED' THEN f.pax ELSE 0 END)                         AS pax_cancelled,
  sum(CASE WHEN f.status = 'SCHEDULED' AND f.delay_min > $sig THEN f.pax ELSE 0 END)  AS pax_delayed,
  sum(CASE WHEN f.status = 'SCHEDULED' THEN f.pax * f.delay_min ELSE 0 END)           AS pax_delay_minutes,
  sum(CASE WHEN f.status = 'SCHEDULED' THEN f.delay_min ELSE 0 END)                   AS total_delay_minutes,
  max(CASE WHEN f.status = 'SCHEDULED' THEN f.delay_min ELSE 0 END)                   AS worst_delay
RETURN cancelled_flights, pax_cancelled, pax_delayed, pax_delay_minutes,
       total_delay_minutes, worst_delay
`

export const COUNT_AFFECTED = `
MATCH (f:Flight)
WHERE f.status = 'SCHEDULED' AND f.delay_min > 0
RETURN count(f) AS affected
`

/* ------------------------------------------------------------------ */
/* Decision and commit — the single write path                         */
/* ------------------------------------------------------------------ */

/**
 * Create the decision and nothing else.
 *
 * The evidence edges are linked by a SEPARATE statement deliberately. An
 * earlier version ended with `UNWIND $affected ... RETURN d.id`, which returns
 * ZERO rows when $affected is empty — UNWIND over an empty list produces no
 * rows, so the RETURN never executes and the caller cannot read back the id it
 * just created. The decision was written, but the write looked like a failure.
 */
export const CREATE_DECISION = `
MATCH (m:Meta {id:'rev'})
CREATE (d:Decision {
  id: $id, created_at: $now, cascade_root: $root,
  plan_json: $plan, evidence_json: $evidence, score_json: $score,
  graph_rev: m.n, status: 'VERIFIED'
})
RETURN d.id AS decision_id
`

/** Attach evidence edges. Safe to skip entirely when the list is empty. */
export const LINK_DECISION_FLIGHTS = `
MATCH (d:Decision {id: $decision_id})
UNWIND $flights AS fid
MATCH (f:Flight {id: fid})
MERGE (d)-[:JUSTIFIED_BY {role: $role}]->(f)
RETURN count(f) AS n
`

export const READ_DECISION = `
MATCH (d:Decision {id: $decision_id})
RETURN d.id AS id, d.created_at AS created_at, d.cascade_root AS cascade_root,
       d.plan_json AS plan_json, d.evidence_json AS evidence_json,
       d.score_json AS score_json, d.graph_rev AS graph_rev, d.status AS status
`

/**
 * Claim a VERIFIED decision for commit, but ONLY if the graph has not moved
 * since it was verified. If d.graph_rev <> m.n the decision is stale and this
 * returns zero rows — the commit must then refuse.
 */
export const CLAIM_DECISION_FOR_COMMIT = `
MATCH (d:Decision {id: $decision_id}), (m:Meta {id:'rev'})
WHERE d.status = 'VERIFIED' AND d.graph_rev = m.n
SET d.status = 'COMMITTED'
RETURN d.plan_json AS plan
`

export const BUMP_REVISION_AND_WRITE_RECEIPT = `
MATCH (m:Meta {id:'rev'}) SET m.n = m.n + 1
WITH m
MATCH (d:Decision {id: $decision_id})
CREATE (r:Receipt {
  id: $receipt_id, decision_id: $decision_id, applied_at: $now,
  before_json: $before, after_json: $after
})
CREATE (r)-[:FOR]->(d)
RETURN r.id AS receipt_id, m.n AS new_rev
`

/** Used only by tests/demo to prove the staleness guard fires. */
export const BUMP_REVISION_ONLY = `
MATCH (m:Meta {id:'rev'}) SET m.n = m.n + 1 RETURN m.n AS n
`

/* ------------------------------------------------------------------ */
/* Passenger recovery (Phase 1 stretch) — build on a fork only         */
/* ------------------------------------------------------------------ */

/**
 * Build the recovery capacity graph: ONE edge per airport pair.
 *
 * Capacity is summed across every flight on that route, and elapsed time is the
 * quickest of them. Creating an edge per flight instead produces parallel edges
 * between the same pair, and `algo.maxFlow` rejects that outright:
 * "relationship type must not contain multi-edges (tensors)".
 *
 * Aggregating is also the right model — for "how many passengers can we move
 * DEL->BLR after 10:00", three aircraft on the route are one pipe with the
 * combined capacity, not three separate choices.
 */
export const BUILD_CAN_CARRY = `
MATCH (f:Flight)
WHERE f.status = 'SCHEDULED' AND f.proj_dep >= $after_min
  AND (f.seats - f.pax) > 0
WITH f.dep_code AS dep, f.arr_code AS arr,
     sum(f.seats - f.pax)            AS capacity,
     min(f.proj_arr - f.proj_dep)    AS elapsed,
     count(f)                        AS flights
MATCH (o:Airport {code: dep}), (d:Airport {code: arr})
MERGE (o)-[c:CAN_CARRY]->(d)
SET c.capacity = capacity, c.elapsed = elapsed, c.hop = 1, c.flights = flights
RETURN count(c) AS edges
`

export const REROUTE_CAPACITY = `
MATCH (s:Airport {code: $origin}), (t:Airport {code: $destination})
CALL algo.maxFlow({
  sourceNodes:       [s],
  targetNodes:       [t],
  relationshipTypes: ['CAN_CARRY'],
  capacityProperty:  'capacity'
})
YIELD nodes, edges, edgeFlows, maxFlow
RETURN maxFlow AS reroutable_seats, size(edges) AS flights_used
`

/** costProp is passed deliberately alongside maxCost — see issue #3109. */
export const REROUTE_ITINERARIES = `
MATCH (s:Airport {code: $origin}), (t:Airport {code: $destination})
CALL algo.SPpaths({
  sourceNode: s,
  targetNode: t,
  relTypes:   ['CAN_CARRY'],
  weightProp: 'elapsed',
  costProp:   'hop',
  maxCost:    3,
  pathCount:  3
})
YIELD path, pathWeight, pathCost
RETURN [n IN nodes(path) | n.code] AS route,
       pathWeight AS total_minutes,
       pathCost   AS connections
ORDER BY total_minutes ASC, connections ASC
`
