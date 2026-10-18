/**
 * Phase 2 — the MCP server. Nine tools: eight read-only, one writer.
 *
 * The contract this file exists to enforce:
 *
 *   THE GRAPH DECIDES. THE MODEL TALKS. A HUMAN CONFIRMS.
 *
 * Concretely, and visible in the code below:
 *
 *   - No tool accepts Cypher. Every query is a fixed, parameterised constant
 *     in packages/graph/src/queries.ts.
 *   - `commit_plan` takes ONLY a decision_id. It never takes a plan body, so
 *     the model cannot invent an action — it can only point at something the
 *     graph already verified.
 *   - `evaluate_plan` is read-only with respect to the live graph: it forks,
 *     tests and deletes. A plan that fails returns its violations as data.
 *   - Nothing here approves anything. Approval is: four invariants return zero
 *     rows, and a human says yes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  buildPlans,
  chooseBest,
  commitDecision,
  connect,
  evaluateAll,
  evaluatePlan,
  explainDelay,
  findCandidates,
  queries,
  rankFragileHandoffs,
  readCascade,
  reroutePassengers,
  run,
  scorePlan,
  StaleDecisionError,
  stressTest,
  traceCascade,
  writeDecision,
  type Session,
} from '@slackline/graph'

/** Every tool returns JSON text. Structured data, never prose. */
function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function fail(code: string, message: string, details?: unknown) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: { code, message, details } }, null, 2) },
    ],
  }
}

/** The fixed action menu, mirrored for tool input. Nothing else can enter. */
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CANCEL_PAIR'), legs: z.tuple([z.string(), z.string()]) }),
  z.object({ type: z.literal('SWAP_TAIL'), flight: z.string(), to_aircraft: z.string() }),
  z.object({ type: z.literal('SWAP_CREW'), flight: z.string(), to_crew: z.string() }),
  z.object({ type: z.literal('ABSORB'), flight: z.string() }),
])

export function buildServer(session: Session): McpServer {
  const server = new McpServer({ name: 'slackline', version: '0.1.0' })
  const { db, graph, name } = session

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

  /* ---------------------------------------------------------------- */
  /* 1. get_network_state — read                                       */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'get_network_state',
    {
      title: 'Get network state',
      description:
        'Counts of flights, aircraft, crew and airports, the current disruptions, and the graph revision. ' +
        'The revision matters: a plan verified at one revision cannot be committed at another.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const state = (await run(graph, queries.NETWORK_STATE))[0] ?? null
      const disruptions = await run(
        graph,
        'MATCH (d:Disruption) RETURN d.id AS id, d.kind AS kind, d.airport_code AS airport_code, ' +
          'd.start_min AS start_min, d.end_min AS end_min, d.impact_min AS impact_min ORDER BY d.id',
      )
      return ok({ state, disruptions, note: 'Synthetic, generated schedule. Not a real operation.' })
    },
  )

  /* ---------------------------------------------------------------- */
  /* 2. trace_cascade — read                                           */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'trace_cascade',
    {
      title: 'Trace a cascade',
      description:
        'Seed a disruption and propagate it to fixpoint across the NEXT_LEG (aircraft) and CREW_NEXT (crew) ' +
        'hand-off edges, then return every affected flight. The propagation is Bellman-Ford relaxation in ' +
        'Cypher; each flight takes the worst of its inbound aircraft and crew delays.',
      inputSchema: { disruption_id: z.string().describe('Disruption node id, e.g. disruption-fog-del') },
      annotations: READ_ONLY,
    },
    async ({ disruption_id }) => {
      try {
        return ok(await traceCascade(graph, disruption_id))
      } catch (err) {
        return fail('TRACE_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  )

  /* ---------------------------------------------------------------- */
  /* 3. explain_flight_delay — read                                    */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'explain_flight_delay',
    {
      title: 'Explain why a flight is late',
      description:
        'Return the shortest chain of hand-offs from a root flight to a target flight, with the slack at each ' +
        'hop. This is the evidence path: the literal reason the delay reached that flight. If no chain exists, ' +
        'the delay did not come from that root — which is itself an answer.',
      inputSchema: {
        root_flight_id: z.string().describe('The flight the disruption hit directly'),
        target_flight_id: z.string().describe('The delayed flight being explained'),
      },
      annotations: READ_ONLY,
    },
    async ({ root_flight_id, target_flight_id }) => {
      const path = await explainDelay(graph, root_flight_id, target_flight_id)
      if (!path) {
        return ok({
          path: null,
          explanation: `No hand-off chain connects ${root_flight_id} to ${target_flight_id}. ` +
            `${target_flight_id}'s delay did not propagate from ${root_flight_id}.`,
        })
      }
      return ok(path)
    },
  )

  /* ---------------------------------------------------------------- */
  /* 4. rank_fragile_handoffs — read                                   */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'rank_fragile_handoffs',
    {
      title: 'Rank fragile hand-offs',
      description:
        'Rank hand-offs by thin slack sitting in front of a large downstream blast radius. ' +
        'blast_radius is the number of flights reachable downstream (descendant-count centrality over the ' +
        'dependency graph) — it is NOT betweenness centrality; do not describe it as such.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: READ_ONLY,
    },
    async ({ limit }) => ok({ handoffs: await rankFragileHandoffs(graph, limit) }),
  )

  /* ---------------------------------------------------------------- */
  /* 5. list_containment_options — read                                */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'list_containment_options',
    {
      title: 'List containment options',
      description:
        'Ask the graph what can be done: cancellable out-and-back pairs, spare aircraft positioned at the ' +
        'right station with no clashing assignment, and reserve crew with duty remaining. Every option is ' +
        'produced by a query — this is the complete menu, and no action exists outside it.',
      inputSchema: {
        threshold: z.number().int().min(0).default(0).describe('Only consider flights delayed beyond this'),
        focus_flights: z.number().int().min(1).max(20).default(5),
      },
      annotations: READ_ONLY,
    },
    async ({ threshold, focus_flights }) => {
      const candidates = await findCandidates(graph, { threshold, focusFlights: focus_flights })
      return ok({ candidates, plans: buildPlans(candidates) })
    },
  )

  /* ---------------------------------------------------------------- */
  /* 6. evaluate_plan — read (forks internally)                        */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'evaluate_plan',
    {
      title: 'Evaluate a plan on a fork',
      description:
        'Copy the graph, apply the plan, re-propagate the cascade, check the four invariants and score the ' +
        'result, then delete the copy. The live graph is never modified. A plan that fails returns ' +
        'verified:false with the offending rows — that is a successful evaluation, not an error. ' +
        'If no plan is given, every graph-derived plan is evaluated and the best verified one is recorded ' +
        'as a Decision, whose decision_id is the ONLY thing commit_plan will accept.',
      inputSchema: {
        disruption_id: z.string(),
        plan: z
          .object({ id: z.string(), actions: z.array(actionSchema) })
          .optional()
          .describe('Omit to evaluate all graph-derived plans and record the best'),
      },
      annotations: READ_ONLY,
    },
    async ({ disruption_id, plan }) => {
      try {
        if (plan) {
          return ok(await evaluatePlan(db, name, plan, { disruptionId: disruption_id }))
        }

        const candidates = await findCandidates(graph, { threshold: 0 })
        const evaluations = await evaluateAll(db, name, buildPlans(candidates), {
          disruptionId: disruption_id,
        })
        const best = chooseBest(evaluations)

        if (!best) {
          return ok({
            evaluations,
            best: null,
            decision_id: null,
            explanation: 'No candidate plan passed all four invariants. Nothing can be committed.',
          })
        }

        const decisionId = `decision-${Date.now().toString(36)}`
        await writeDecision(graph, {
          id: decisionId,
          cascadeRoot: '',
          plan: best.plan,
          evidence: {},
          score: await scorePlan(graph),
          affected: (await readCascade(graph)).map((f) => f.flight),
        })

        return ok({
          evaluations,
          best,
          decision_id: decisionId,
          next_step: 'A human must confirm before commit_plan is called with this decision_id.',
        })
      } catch (err) {
        return fail('EVALUATE_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  )

  /* ---------------------------------------------------------------- */
  /* 7. reroute_passengers — read (forks internally)                   */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'reroute_passengers',
    {
      title: 'Reroute stranded passengers',
      description:
        'Build a CAN_CARRY capacity graph of remaining seats on a fork, then use algo.maxFlow to find how ' +
        'many passengers can physically be moved and algo.SPpaths for the actual itineraries. Seats are ' +
        'capacities; passengers are flow. maxFlow returns a flow value, not a min-cut.',
      inputSchema: {
        origin: z.string().describe('Origin airport code'),
        destination: z.string().describe('Destination airport code'),
        after_min: z.number().int().describe('Only flights departing after this minute can carry them'),
      },
      annotations: READ_ONLY,
    },
    async ({ origin, destination, after_min }) => {
      try {
        return ok(await reroutePassengers(db, name, { origin, destination, afterMin: after_min }))
      } catch (err) {
        return fail('REROUTE_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  )

  /* ---------------------------------------------------------------- */
  /* 8. stress_test — read (forks internally)                          */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'stress_test',
    {
      title: 'Stress test a what-if scenario',
      description:
        'Run a hypothetical disruption on a throwaway fork and report what breaks: which invariants fail and ' +
        'which hand-offs ran out of buffer, ranked by how many minutes of slack they were short. It proposes ' +
        'nothing — it reports where the schedule is thin.',
      inputSchema: {
        airport_code: z.string(),
        kind: z.enum(['FOG', 'ATC', 'TECH', 'RULE_CHANGE']).default('FOG'),
        start_min: z.number().int().default(330),
        end_min: z.number().int().default(510),
        impact_min: z.number().int().default(120),
      },
      annotations: READ_ONLY,
    },
    async ({ airport_code, kind, start_min, end_min, impact_min }) => {
      try {
        return ok(await stressTest(db, name, { airport_code, kind, start_min, end_min, impact_min }))
      } catch (err) {
        return fail('STRESS_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  )

  /* ---------------------------------------------------------------- */
  /* 9. commit_plan — THE ONLY WRITER                                  */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'commit_plan',
    {
      title: 'Commit a verified decision',
      description:
        'Apply a decision that has ALREADY been verified, and write its receipt. Takes only a decision_id — ' +
        'never a plan body, so no action can be introduced here that the graph did not verify. Refuses if the ' +
        'decision is not VERIFIED, or if the live graph has changed since it was verified: a plan proven safe ' +
        'against one state of the world is not proven safe against another. ' +
        'Call this ONLY after a human has confirmed the plan.',
      inputSchema: {
        decision_id: z.string().describe('From evaluate_plan. A plan body is not accepted.'),
        disruption_id: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ decision_id, disruption_id }) => {
      try {
        const receipt = await commitDecision(graph, decision_id, { disruptionId: disruption_id })
        return ok({ receipt, committed: true })
      } catch (err) {
        if (err instanceof StaleDecisionError) {
          return fail('STALE_DECISION', err.message, {
            decision_rev: err.decisionRev,
            current_rev: err.currentRev,
            remedy: 'Re-run evaluate_plan to verify against the current graph, then confirm again.',
          })
        }
        return fail('COMMIT_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  )

  return server
}

/* Entry point — stdio transport. */
if (process.argv[1]?.includes('mcp')) {
  const session = await connect()
  const server = buildServer(session)
  await server.connect(new StdioServerTransport())
  // stdout is the protocol channel; logs must go to stderr.
  console.error(`slackline mcp server ready (graph "${session.name}")`)
}
