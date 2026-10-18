/**
 * Connection check. Run this before anything else.
 *
 * It also probes the two hosted-tier capabilities the product cannot work
 * without: GRAPH.COPY, and the graph algorithms used for passenger recovery.
 * See docs/kickoff.md 1.1 and 16.1.
 */

import { connect, fork } from '@slackline/graph'

async function main() {
  const session = await connect()
  const { db, graph, name } = session

  try {
    const ping = await graph.query<{ ok: number }>('RETURN 1 AS ok')
    console.log(`[ok]   connected, graph "${name}" responded:`, ping.data?.[0])

    // GRAPH.COPY is the whole basis of fork/verify. If it is unavailable on
    // this tier, the product cannot verify a plan before acting.
    try {
      const { sim, dest } = await fork(db, name)
      await sim.delete()
      console.log(`[ok]   GRAPH.COPY works (forked to ${dest}, deleted)`)
    } catch (err) {
      console.error('[FAIL] GRAPH.COPY unavailable — fork/verify cannot work on this instance.')
      console.error('       ', err instanceof Error ? err.message : err)
      process.exitCode = 1
    }

    for (const [label, probe] of [
      ['algo.maxFlow', 'CALL algo.maxFlow({sourceNodes: [], targetNodes: [], relationshipTypes: ["X"], capacityProperty: "c"}) YIELD maxFlow RETURN maxFlow'],
      ['algo.SPpaths', 'CALL algo.SPpaths({sourceNode: null, targetNode: null, relTypes: ["X"], weightProp: "w"}) YIELD pathWeight RETURN pathWeight'],
    ] as const) {
      try {
        await graph.query(probe)
        console.log(`[ok]   ${label} is available`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // An argument-level complaint still proves the procedure is registered.
        if (/unknown procedure|not registered/i.test(message)) {
          console.warn(`[warn] ${label} NOT available — passenger recovery (stretch) is out.`)
        } else {
          console.log(`[ok]   ${label} is registered`)
        }
      }
    }

    const graphs = await db.list()
    console.log(`[info] graphs on this instance: ${graphs.join(', ') || '(none)'}`)
  } finally {
    await session.close()
  }
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err)
  process.exit(1)
})
