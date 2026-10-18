/**
 * Wipe, generate and ingest. `pnpm seed -- --seed 42`
 *
 * Seeded and idempotent: the same seed always produces the same graph.
 */

import { applySchema, connect, generate, ingest, wipe } from '@slackline/graph'

function parseSeed(argv: string[]): number {
  const index = argv.indexOf('--seed')
  if (index === -1) return 42
  const value = Number(argv[index + 1])
  if (!Number.isFinite(value)) throw new Error('--seed requires a number')
  return value
}

async function main() {
  const seed = parseSeed(process.argv)
  const session = await connect()

  try {
    console.log(`Seeding graph "${session.name}" with seed ${seed}...`)

    await wipe(session.graph)
    const { indexes, constraints } = await applySchema(session.graph)
    console.log(`  schema:     ${indexes} indexes, ${constraints} unique constraints`)

    const schedule = generate({ seed })
    const counts = await ingest(session.graph, schedule)

    console.log(
      `  ingested:   ${counts.flights} flights, ${counts.aircraft} aircraft, ` +
        `${counts.crew} crew, ${counts.airports} airports`,
    )
    console.log(`  hand-offs:  ${counts.nextLeg} NEXT_LEG, ${counts.crewNext} CREW_NEXT`)
    console.log(`  disruption: ${schedule.disruptions.map((d) => d.id).join(', ')}`)
    console.log(
      `  thin turns: ${schedule.thinHandoffs
        .map((t) => `${t.from}->${t.to} (slack ${t.slack_min})`)
        .join(', ')}`,
    )
    console.log('Done. Synthetic data only — no real schedule was used.')
  } finally {
    await session.close()
  }
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err)
  process.exit(1)
})
