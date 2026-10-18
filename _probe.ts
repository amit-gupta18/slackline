import 'dotenv/config'
import { FalkorDB } from 'falkordb'

const raw = process.env.FALKOR_URL!
const u = new URL(raw)
const host = u.hostname
const port = Number(u.port)

const attempts: Array<{ label: string; opts: Record<string, unknown> }> = [
  { label: 'url as-is (user=falkordb, no password)', opts: { url: raw } },
  { label: 'no credentials at all', opts: { socket: { host, port, tls: false } } },
  { label: 'user=default, no password', opts: { socket: { host, port, tls: false }, username: 'default' } },
  { label: 'url as-is + TLS', opts: { url: raw.replace('falkor://', 'falkors://') } },
]

for (const a of attempts) {
  try {
    const db = await FalkorDB.connect({ ...a.opts, socket: { ...(a.opts as any).socket, connectTimeout: 8000 } } as any)
    const g = db.selectGraph('probe_tmp')
    await g.query('RETURN 1 AS ok')
    console.log(`  CONNECTED  ${a.label}`)
    await db.close()
    break
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    console.log(`  failed     ${a.label}  ->  ${m.slice(0, 90)}`)
  }
}
