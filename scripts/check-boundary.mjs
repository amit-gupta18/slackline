/**
 * Enforces the datastore boundary from docs/kickoff.md 0.1.
 *
 *   packages/graph       must never import mongoose
 *   apps/api/src/mongo   must never import the graph package
 *
 * FalkorDB is the primary database and the only thing on the decision path
 * (hackathon Rule 2). MongoDB is the app shell. If these two ever touch, the
 * ablation test stops meaning anything.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RULES = [
  {
    dir: 'packages/graph/src',
    forbidden: /from\s+['"]mongoose['"]|require\(['"]mongoose['"]\)/,
    message: 'packages/graph must not import mongoose — account data is not on the decision path.',
  },
  {
    dir: 'apps/api/src/mongo',
    forbidden: /from\s+['"]@slackline\/graph/,
    message: 'apps/api/src/mongo must not import @slackline/graph — the app shell stays out of the product.',
  },
]

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out // directory not created yet — nothing to check
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full)
  }
  return out
}

let failures = 0
for (const rule of RULES) {
  for (const file of walk(rule.dir)) {
    const source = readFileSync(file, 'utf8')
    if (rule.forbidden.test(source)) {
      console.error(`BOUNDARY VIOLATION  ${file}\n  ${rule.message}`)
      failures++
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} boundary violation(s).`)
  process.exit(1)
}
console.log('boundary ok — graph and app shell are separate.')
