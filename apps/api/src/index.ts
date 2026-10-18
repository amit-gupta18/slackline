/**
 * Express + TypeScript API.
 *
 * Handlers are thin: validate with zod, call ONE function from
 * @slackline/graph, return its result unchanged. No handler performs
 * arithmetic over domain values — every number it returns came from a query.
 *
 * If FalkorDB is unreachable, routes return 503. There is no cached, defaulted
 * or degraded answer anywhere in this file (hackathon Rule 3).
 */

import express, { type NextFunction, type Request, type Response } from 'express'
import { connect, type Session } from '@slackline/graph'
import { analysisRoutes } from './routes/analysis.js'
import { networkRoutes } from './routes/network.js'
import { planRoutes } from './routes/plans.js'

export async function createApp(session: Session) {
  const app = express()
  app.use(express.json())

  // The Next.js dev server runs on a different port. Local development only.
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.WEB_ORIGIN ?? 'http://localhost:3001')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    next()
  })
  app.options(/.*/, (_req, res) => res.sendStatus(204))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, graph: session.name })
  })

  app.use('/api/network', networkRoutes(session))
  app.use('/api/plans', planRoutes(session))
  app.use('/api/analysis', analysisRoutes(session))

  // A rejected plan is a SUCCESSFUL evaluation, so it never reaches here.
  // This handler is for real failures only.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err)
    const unreachable = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|closed|socket/i.test(message)

    res.status(unreachable ? 503 : 500).json({
      error: {
        code: unreachable ? 'GRAPH_UNAVAILABLE' : 'INTERNAL',
        message: unreachable
          ? 'FalkorDB is unreachable. The product cannot answer without the graph.'
          : message,
      },
    })
  })

  return app
}

// Entry point. `pnpm dev:api`
if (process.argv[1]?.endsWith('index.ts')) {
  const session = await connect()
  const app = await createApp(session)
  const port = Number(process.env.PORT ?? 4000)

  app.listen(port, () => {
    console.log(`slackline api on :${port} (graph "${session.name}")`)
  })
}
