/**
 * Test harness.
 *
 * Integration tests run against a DEDICATED test graph (GRAPH_NAME + "_test"),
 * never the demo graph. Each suite wipes and reseeds it.
 *
 * If FALKOR_URL is not set, the integration suites skip with a loud notice
 * rather than failing — but note that a skipped suite proves nothing. CI for
 * the submission must run them with a live instance.
 */

import 'dotenv/config'
import { describe } from 'vitest'
import {
  applySchema,
  connect,
  generate,
  ingest,
  wipe,
  type Session,
} from '@slackline/graph'
import type { Schedule } from '@slackline/shared'

export const HAS_FALKOR = Boolean(process.env.FALKOR_URL)

if (!HAS_FALKOR) {
  console.warn(
    '\n[tests] FALKOR_URL is not set — integration suites will SKIP.\n' +
      '        A skipped suite is not a passing suite. Set FALKOR_URL to a\n' +
      '        FalkorDB instance before trusting a green run.\n',
  )
}

/** describe() that skips the whole suite when there is no graph to talk to. */
export const describeGraph: typeof describe = (HAS_FALKOR ? describe : describe.skip) as typeof describe

export const TEST_GRAPH = `${process.env.GRAPH_NAME ?? 'slackline'}_test`

export async function openTestSession(): Promise<Session> {
  return connect({ graphName: TEST_GRAPH })
}

/** Wipe, apply schema, generate and ingest. Returns the schedule that was loaded. */
export async function reseed(session: Session, seed = 42): Promise<Schedule> {
  await wipe(session.graph)
  await applySchema(session.graph)
  const schedule = generate({ seed })
  await ingest(session.graph, schedule)
  return schedule
}

/** The default disruption every suite uses. */
export const DISRUPTION_ID = 'disruption-fog-del'
