/**
 * The four invariants. Proof by zero rows.
 *
 * Each is a query that MUST return nothing on a valid plan. A non-empty result
 * is a rejection, carrying the offending rows as evidence. Absence of a
 * matching pattern is the proof of safety.
 */

import type { Violation } from '@slackline/shared'
import { run, type Graph } from './db.js'
import {
  INV_1_DUTY,
  INV_2_TURNAROUND,
  INV_3_START_POSITION,
  INV_3_TAIL_CONTINUITY,
  INV_4_TERMINAL_STATUS,
} from './queries.js'

interface Check {
  id: Violation['invariant']
  query: string
  message: string
}

const CHECKS: Check[] = [
  {
    id: 'INV-1',
    query: INV_1_DUTY,
    message: 'crew duty window exceeds its legal limit',
  },
  {
    id: 'INV-2',
    query: INV_2_TURNAROUND,
    message: 'aircraft turnaround is shorter than the minimum',
  },
  {
    id: 'INV-3',
    query: INV_3_TAIL_CONTINUITY,
    message: 'tail continuity broken — aircraft lands at one airport and departs from another',
  },
  {
    id: 'INV-3',
    query: INV_3_START_POSITION,
    message: "tail continuity broken — aircraft's first leg departs somewhere it has never been",
  },
  {
    id: 'INV-4',
    query: INV_4_TERMINAL_STATUS,
    message: 'flight has no terminal status',
  },
]

/**
 * Run all four. They are read-only and independent, so they run concurrently.
 * A plan is VERIFIED only when this returns an empty array.
 */
export async function checkAll(graph: Graph): Promise<Violation[]> {
  const results = await Promise.all(
    CHECKS.map(async (check): Promise<Violation | null> => {
      const rows = await run<Record<string, unknown>>(graph, check.query)
      if (rows.length === 0) return null
      return { invariant: check.id, message: check.message, rows }
    }),
  )
  return results.filter((v): v is Violation => v !== null)
}

/** Human-readable one-liner for the demo output and for rejection messages. */
export function describeViolation(violation: Violation): string {
  const first = violation.rows[0]
  const detail = first ? JSON.stringify(first) : ''
  const more = violation.rows.length > 1 ? ` (+${violation.rows.length - 1} more)` : ''
  return `${violation.invariant} ${violation.message}: ${detail}${more}`
}
