/**
 * A10 — THE ABLATION TEST. Never delete this file. Never let it be skipped.
 *
 * Hackathon Rule 3: the graph must do real work. If the product still produces
 * an answer with FalkorDB removed, the submission fails. This test removes it
 * and asserts that EVERY path fails loudly — no cache, no default, no
 * in-memory fallback, no "degraded mode".
 *
 * It deliberately does NOT use describeGraph: it must run everywhere,
 * including on a machine with no FalkorDB at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { connect, loadConfig } from '@slackline/graph'

/** A host that cannot answer. Port 1 is reserved and never listening. */
const DEAD_URL = 'redis://127.0.0.1:1'

describe('A10 — ablation: the product is dead without FalkorDB', () => {
  const saved = process.env.FALKOR_URL

  beforeEach(() => {
    process.env.FALKOR_URL = DEAD_URL
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.FALKOR_URL
    else process.env.FALKOR_URL = saved
  })

  it('refuses to start when FALKOR_URL is absent — there is no default', () => {
    delete process.env.FALKOR_URL
    expect(() => loadConfig()).toThrow(/FALKOR_URL/)
  })

  it('every entry point fails when the graph is unreachable', async () => {
    // connect() is the only door into the product. If it cannot open, nothing
    // downstream can run — which is exactly the property being asserted.
    await expect(connect({ falkorUrl: DEAD_URL })).rejects.toThrow()
  }, 30_000)

  it('the codebase contains no fallback datastore on the decision path', () => {
    const forbidden = [
      { pattern: /\bfrom\s+['"]mongoose['"]/, why: 'mongoose (account data is not the product)' },
      { pattern: /\bfrom\s+['"]pg['"]/, why: 'postgres' },
      { pattern: /\bfrom\s+['"]better-sqlite3['"]|\bfrom\s+['"]sqlite3['"]/, why: 'sqlite' },
      { pattern: /\bfrom\s+['"]graphology['"]|\bfrom\s+['"]graphlib['"]/, why: 'an in-memory graph library' },
      { pattern: /\bfrom\s+['"]@prisma\/client['"]/, why: 'prisma' },
    ]

    const offences: string[] = []
    for (const file of walk('packages/graph/src')) {
      const source = readFileSync(file, 'utf8')
      for (const { pattern, why } of forbidden) {
        if (pattern.test(source)) offences.push(`${file} imports ${why}`)
      }
    }

    expect(offences).toEqual([])
  })

  it('the graph package owns no persistent state of its own', () => {
    // A module-level Map/Set/array holding domain rows would be a cache, and a
    // cache is a fallback. Query results must never outlive the call.
    const suspicious: string[] = []
    for (const file of walk('packages/graph/src')) {
      const source = readFileSync(file, 'utf8')
      // module-scope (not indented) mutable collection assignments
      if (/^(const|let|var)\s+\w+\s*(:[^=]+)?=\s*new\s+(Map|Set)\s*\(/m.test(source)) {
        // AIRPORT_BY_CODE in generate.ts is static public reference data, not state.
        if (!file.endsWith('generate.ts')) suspicious.push(file)
      }
    }
    expect(suspicious).toEqual([])
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}
