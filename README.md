# Slackline

**Graph-native cascade containment for airline operations.**

Track: **01 — Agents That Act on Connected Data** · Graph Hacks: Context for AI Agents, powered by FalkorDB

> **The graph decides. The model talks. A human confirms.**

An airline reuses the same aircraft and crew across many flights a day, so each flight depends on the one before it. One delay travels down the chain; a crew hitting its legal duty limit breaks the chain outright. Slackline models that dependency chain in FalkorDB, traces a cascade as a graph computation, assembles candidate containment plans **from the graph**, verifies each plan on a `GRAPH.COPY` fork against hard invariants, and presents a verified plan with its evidence path for a human to confirm.

> **SIMULATION — all schedule data in this project is synthetic and generated.** Airport codes and coordinates are public. No real airline schedule, tail, crew or passenger data is used anywhere.

---

## Status

All four phases are implemented. Offline tests pass and the Next.js app builds; **the integration suite and the demo still need a FalkorDB connection string** to run.

| Phase | What | State |
|---|---|---|
| 1 | Backend: schema, cascade, invariants, fork/verify, commit | Implemented |
| 2 | MCP server — 9 tools, 8 read-only, 1 writer | Implemented |
| 3 | Next.js UI — map, cascade, evidence, plans, fragility | Implemented |
| 4 | README, demo script, blog post | Written; **video not recorded** |

| | |
|---|---|
| Graph engine | FalkorDB Cloud (free tier) — connection string, no Docker required |
| Backend | Express + TypeScript |
| Frontend | Next.js — map, cascade table, evidence panel, plan verdicts |
| Agent interface | MCP over stdio (`@modelcontextprotocol/sdk`) |
| App shell | MongoDB + Mongoose, accounts only, **off the decision path** |

---

## Setup

```bash
pnpm install
cp .env.example .env        # paste FALKOR_URL from the FalkorDB Cloud UI
pnpm smoke                  # connection + GRAPH.COPY + algo.* capability probe
pnpm seed                   # wipe, generate (seed 42), ingest
pnpm demo                   # the end-to-end Phase 1 demo
pnpm test                   # acceptance tests A1-A11
pnpm lint:boundary          # proves MongoDB is not on the decision path

pnpm dev:api                # API on :4000
pnpm dev:web                # UI  on :3001
pnpm mcp                    # MCP server on stdio
```

Only `FALKOR_URL` is required. The demo and the tests run with `MONGODB_URI` unset — the product does not need an account database to work.

Local fallback, if the hosted tier forbids `GRAPH.COPY`:

```bash
docker run -d -p 6379:6379 -p 3000:3000 falkordb/falkordb:latest
# then FALKOR_URL=redis://localhost:6379
```

---

## The graph data model

All times are **integer minutes from 00:00** of the operating day.

### Nodes

| Label | Key properties |
|---|---|
| `Airport` | `code`, `name`, `city`, `lat`, `lon` |
| `Flight` | `id`, `flight_no`, `dep_code`, `arr_code`, `sched_dep`, `sched_arr`, `proj_dep`, `proj_arr`, `delay_min`, `pax`, `seats`, `status`, `tail_id`, `crew_id` |
| `Aircraft` | `id`, `type`, `base`, `is_spare` |
| `Crew` | `id`, `name`, `base`, `duty_start`, `duty_limit_min`, `is_reserve` |
| `Disruption` | `id`, `kind`, `airport_code`, `start_min`, `end_min`, `impact_min` |
| `Decision` | `id`, `created_at`, `plan_json`, `evidence_json`, `score_json`, `graph_rev`, `status` |
| `Receipt` | `id`, `decision_id`, `applied_at`, `before_json`, `after_json` |
| `Meta` | `id` (`"rev"`), `n` — the revision counter behind the staleness guard |

### Relationships

| Type | From → To | Properties |
|---|---|---|
| `DEPARTS_FROM` / `ARRIVES_AT` | `Flight` → `Airport` | — |
| `OPERATES` | `Aircraft` → `Flight` | — |
| `ASSIGNED_TO` | `Crew` → `Flight` | — |
| **`NEXT_LEG`** | `Flight` → `Flight` | `min_turn`, `sched_ground`, `slack_min` |
| **`CREW_NEXT`** | `Flight` → `Flight` | `min_rest`, `sched_ground`, `slack_min` |
| `HITS` | `Disruption` → `Airport` | `impact_min` |
| `JUSTIFIED_BY` | `Decision` → `Flight` | `role` |
| `FOR` | `Receipt` → `Decision` | — |
| `CAN_CARRY` | `Airport` → `Airport` | `flight_id`, `capacity`, `elapsed`, `hop` |

**The modelling insight:** `slack_min = sched_ground − min_turn` (or `− min_rest`). **Slack is a property of the hand-off, not of a flight.** `NEXT_LEG` and `CREW_NEXT` carry the entire thesis of the project — they are what turns "a delay" into "a cascade you can trace".

---

## The queries the product depends on

Every statement lives in [`packages/graph/src/queries.ts`](packages/graph/src/queries.ts) — there is no inline Cypher anywhere else in the codebase.

### The cascade — one relaxation wave (Bellman-Ford over hand-offs)

Run repeatedly until it returns `changed = 0`.

```cypher
MATCH (a:Flight)-[e:NEXT_LEG|CREW_NEXT]->(b:Flight)
WHERE a.status = 'SCHEDULED'
  AND b.status = 'SCHEDULED'
  AND (a.delay_min - e.slack_min) > b.delay_min
WITH b, max(a.delay_min - e.slack_min) AS new_delay
SET b.delay_min = new_delay,
    b.proj_dep  = b.sched_dep + new_delay,
    b.proj_arr  = b.sched_arr + new_delay
RETURN count(b) AS changed
```

`max()` is what makes a flight take the worst of its inbound aircraft delay and its inbound crew delay — a flight waits for **both**. The relationship `e` is named deliberately: FalkorDB only existence-checks unnamed relationships.

### The evidence path — "why is this flight late?"

```cypher
MATCH p = (root:Flight {id: $root_id})-[:NEXT_LEG|CREW_NEXT*1..8]->(target:Flight {id: $target_id})
RETURN [n IN nodes(p) | n.id]                AS chain,
       [r IN relationships(p) | type(r)]     AS hop_types,
       [r IN relationships(p) | r.slack_min] AS slack_at_each_hop,
       length(p)                             AS hops
ORDER BY hops ASC
LIMIT 1
```

### The four invariants — proof by zero rows

A plan is `VERIFIED` only when **all four return nothing**. Absence of a matching pattern is the proof of safety.

- **INV-1** — no crew's projected duty window exceeds `duty_limit_min`
- **INV-2** — no aircraft turnaround is shorter than `min_turn`
- **INV-3** — **tail continuity**: for consecutive legs of one aircraft, `a.arr_code = b.dep_code`
- **INV-4** — every flight has a terminal status

INV-3 is the one an early design draft missed. Cancelling a single mid-rotation leg strands the aircraft in the wrong city, so **cancellations must be out-and-back pairs**. A plan that trips INV-3 being correctly rejected is a real demo moment, and [`tests/invariants.test.ts`](tests/invariants.test.ts) asserts exactly that.

```cypher
MATCH (ac:Aircraft)-[:OPERATES]->(f:Flight)
WHERE f.status = 'SCHEDULED'
WITH ac, f ORDER BY f.proj_dep
WITH ac, collect(f) AS legs
UNWIND range(0, size(legs) - 2) AS i
WITH ac, legs[i] AS a, legs[i+1] AS b
WHERE a.arr_code <> b.dep_code
RETURN ac.id AS aircraft, a.id AS from_flight, a.arr_code AS lands_at,
       b.id AS to_flight, b.dep_code AS departs_from
ORDER BY aircraft, from_flight
```

### Scoring — every reported figure comes from this query

```cypher
MATCH (f:Flight)
WITH
  sum(CASE WHEN f.status = 'CANCELLED' THEN 1 ELSE 0 END)                            AS cancelled_flights,
  sum(CASE WHEN f.status = 'CANCELLED' THEN f.pax ELSE 0 END)                        AS pax_cancelled,
  sum(CASE WHEN f.status = 'SCHEDULED' AND f.delay_min > $sig THEN f.pax ELSE 0 END) AS pax_delayed,
  sum(CASE WHEN f.status = 'SCHEDULED' THEN f.delay_min ELSE 0 END)                  AS total_delay_minutes,
  max(CASE WHEN f.status = 'SCHEDULED' THEN f.delay_min ELSE 0 END)                  AS worst_delay
RETURN cancelled_flights, pax_cancelled, pax_delayed, total_delay_minutes, worst_delay
```

**Objective:**

```
score = pax_cancelled * 3  +  (pax_delay_minutes / 60) * 1
```

Three points per cancelled passenger, one per **passenger-hour** of delay — so stranding someone outright costs about what delaying them three hours costs.

Lower is better. **These weights are a declared heuristic, not a derived optimum**, and the ratio is a judgement call, not an airline's cost model.

The delay term is weighted by both *how many* passengers are affected and *how long* each waits. An earlier version scored delay per flight-minute regardless of load, which made the cancellation penalty so dominant that no cancellation could ever improve the score whatever it saved downstream — the planner's only winning move was to do nothing. Weighting by passenger-hours fixed that.

TypeScript picks the argmin over graph-computed scores — comparison only, no domain logic. **It only ever ranks VERIFIED plans:** a rejected plan usually scores lower (doing nothing normally does), and is never chosen. Safety is not traded off against the objective.

### Graph algorithms

`algo.maxFlow` is used for its actual purpose: **seats are capacities, passengers are flow**. `algo.SPpaths` returns the concrete rebooking itinerary. Both are in `queries.ts` (`REROUTE_CAPACITY`, `REROUTE_ITINERARIES`).

---

## How it works

```
seed disruption → relax to fixpoint → read cascade + evidence
      ↓
candidates FROM THE GRAPH (cancel-pairs, spare tails, reserve crew)
      ↓
for each plan:  GRAPH.COPY fork → apply → reset+repropagate → 4 invariants → score → DELETE fork
      ↓
argmin over verified plans → Decision (status VERIFIED, stamped with graph_rev)
      ↓
commit(decision_id)  →  refuses if graph_rev ≠ current rev  →  apply + Receipt + rev++
```

Two properties worth pointing at:

- **The fork is deleted in a `finally` block, always** — including when the work inside throws. Asserted by test A5.
- **The staleness guard.** A decision records the graph revision it was verified against. If the live graph moved in between, commit **refuses**. A plan proven safe against one state of the world is not proven safe against another. Asserted by test A9.

---

## The agent interface (Phase 2)

Nine MCP tools. Copy `.mcp.json.example` to `.mcp.json`, add your connection string, and point any MCP client at it.

| Tool | Access | Returns |
|---|---|---|
| `get_network_state` | read | counts, disruptions, graph revision |
| `trace_cascade` | read | affected flights after propagation to fixpoint |
| `explain_flight_delay` | read | the evidence chain, with slack at each hop |
| `rank_fragile_handoffs` | read | thin slack in front of a large blast radius |
| `list_containment_options` | read | graph-derived candidate actions |
| `evaluate_plan` | read (forks internally) | violations + score, and a `decision_id` if verified |
| `reroute_passengers` | read (forks internally) | `maxFlow` capacity + `SPpaths` itineraries |
| `stress_test` | read (forks internally) | breakages + missing-slack ranking |
| **`commit_plan`** | **WRITE** | receipt, or a refusal with its reason |

Three properties are structural, not conventions:

- **No tool accepts Cypher.** Every query is a fixed parameterised constant.
- **`commit_plan` takes only a `decision_id`** — there is no parameter through which an invented action could arrive. The model can only point at something the graph already verified.
- **Nothing here approves anything.** Approval is: four invariants return zero rows, and a human says yes.

---

## The operator view (Phase 3)

`pnpm dev:web` — trace a cascade, see it on the map, click any flight to get its evidence chain, review graph-derived plans with their verdicts, and confirm a commit.

The UI computes nothing. Every number on screen came from the API, which got it from a query. The simulation banner is not decorative — honesty rule 8.1 requires it on every view showing product numbers.

---

## Architecture

```
packages/graph/   the product — FalkorDB and nothing else
packages/shared/  types shared by api and web
apps/api/         Express + TypeScript; apps/api/src/mongo is the app shell
apps/mcp/         MCP server — 9 tools over stdio
apps/web/         Next.js operator view
scripts/          smoke, seed, demo, check-boundary
tests/            acceptance tests A1-A11
```

### Why MongoDB is here, and why it changes nothing

FalkorDB is the primary database and the only thing on the decision path. MongoDB holds users, credentials and sessions — **nothing else**. Dropping the Mongo database does not change a single number the product reports.

| FalkorDB (the product) | MongoDB (the app shell) |
|---|---|
| Flights, aircraft, crew, airports, disruptions | Users, hashed credentials |
| `NEXT_LEG` / `CREW_NEXT` and every other edge | Sessions / JWT |
| Cascade state, candidates, plans, scores | UI preferences, login audit |
| `Decision`, `Receipt`, `Meta.rev` | — |

This is enforced mechanically, not by convention: `packages/graph` may not import `mongoose`, and `pnpm lint:boundary` fails the build if it does.

Postgres + Prisma was considered and rejected: the only thing it buys over Mongoose is multi-row transactional integrity, and a user document and a session are independent single-document writes. If a feature ever genuinely needs supervised transactions, that is the trigger to revisit it — and only for that feature.

**Express + TypeScript, not FastAPI.** All graph work (`algo.*`, Cypher) executes server-side inside FalkorDB; the backend sends parameterised strings and reads result sets, so the client language cannot limit what the graph computes. Phase 1 has no ML or numeric workload, and the MCP SDK is first-class TypeScript. Full reasoning in [`docs/kickoff.md`](docs/kickoff.md) §1.2.

---

## Tests

| ID | Asserts |
|---|---|
| A1 | Indexes and constraints exist; duplicate `Flight.id` rejected |
| A2 | Relaxation reaches fixpoint in < 50 waves; final wave changes nothing |
| A3 | Hand-built 5-flight chain with slack 20 yields exactly `[120, 100, 80, 60, 40]` |
| A4 | A flight with a delayed aircraft **and** a delayed crew inbound takes the larger |
| A5 | Fork mutations never reach the live graph; fork deleted even when the body throws |
| A6 | Cancelling one mid-rotation leg trips INV-3; cancelling the pair does not |
| A7 | Pushing a crew past `duty_limit_min` trips INV-1 |
| A8 | The chosen plan scores strictly better than the do-nothing baseline |
| A9 | A decision verified at an older revision is refused at commit |
| A10 | **With FalkorDB unreachable, every path fails. No fallback produces a plan.** |
| A11 | Same seed → identical schedule, cascade and chosen plan |

**A10 is the ablation test** and the direct answer to hackathon Rule 3. It runs with the graph pointed at a dead host and asserts the product is inert: no cache, no default, no degraded mode. It also greps the source for forbidden datastore imports. **Never delete it, never let it be skipped.**

A skipped integration suite proves nothing — `pnpm test` prints a loud warning when `FALKOR_URL` is unset.

---

## Declared limitations

Honesty about what this is, because the judging criteria include understanding and verifiability:

1. **Synthetic data throughout.** Generated schedule, generated tails, crew and passenger counts. Only airport codes and coordinates are real.
2. **One duty rule**, not the full DGCA FDTL CAR. `duty_limit_min = 780` is a **placeholder parameter** pending a read of the actual regulation — it is not a sourced regulatory figure and must not be quoted as one.
3. **Block time is a linear function of great-circle distance**, clamped to 50–120 min, so a rotation fits one operating day.
4. **Deterministic delay arithmetic.** No stochastic taxi, weather or ATC variation.
5. **A fixed action menu** — cancel-pair, tail swap, crew swap, absorb. Not an optimiser over the full action space.
6. **Single operating day**, 05:00–23:00, no day-boundary handling, no timezones.
7. **The containment selection is a scored heuristic** over graph-generated candidates, with declared weights. It is not a proof of optimality.
8. **Decision support, not autopilot.** The invariants only cover what is modelled. Bad input data can still produce a plan that passes verification.
9. **Not a replacement for operations solvers.** Lufthansa's OPSD is a mature deployed system. Slackline's position is: a way to *see* the whole chain, *explain* every suggestion, and *test* it before acting.

---

## How I used Claude Code

This project was built with Claude Code as a coding assistant, as permitted by hackathon Rule 11.

- **Specification.** `docs/kickoff.md` and `docs/AGENTS.md` were drafted and iterated with Claude, including the stack decision (Express/TS over FastAPI) and the MongoDB boundary rules.
- **Implementation.** The `packages/graph` modules, the Cypher in `queries.ts`, the Express routes and the test suite were written with Claude Code.
- **Verification.** An independent plain-TypeScript oracle was used to check the generator against the same four invariants the Cypher enforces. It caught three real bugs before any database was involved: a negative crew-rest slack caused by tightening a hand-off to `min_turn` when `min_rest` is longer, a rotation overrunning the 23:00 day boundary, and over-eager crew chunking.
- **Author's understanding.** The graph model, the relaxation loop, the four invariants, the fork/verify flow and the staleness guard are explained in this README and in `docs/kickoff.md`, and I can walk through each without notes.

---

## Further reading

- [`docs/kickoff.md`](docs/kickoff.md) — the full technical specification
- [`docs/AGENTS.md`](docs/AGENTS.md) — rules and hard constraints for anyone (human or AI) working in this repo
- [`docs/ps.md`](docs/ps.md) — the problem, with sourced evidence
- [`docs/demo-script.md`](docs/demo-script.md) — demo video script
- [`docs/blog-post.md`](docs/blog-post.md) — write-up draft
- [`docs/submission.md`](docs/submission.md) — submission checklist and open items

---

## Licence

Synthetic data only. See `docs/ps.md` for the sourced evidence behind the problem statement; every figure there carries its source.
