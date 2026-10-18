/**
 * Fragility, stress testing and passenger recovery.
 *
 * All read-only with respect to the live graph: stress tests and reroutes
 * build their derived state on a fork and throw it away.
 */

import { Router } from 'express'
import { z } from 'zod'
import { rankFragileHandoffs, reroutePassengers, stressTest, type Session } from '@slackline/graph'

export function analysisRoutes(session: Session): Router {
  const router = Router()

  router.get('/fragile', async (req, res, next) => {
    const limit = Number(req.query.limit ?? 20)
    try {
      res.json({ handoffs: await rankFragileHandoffs(session.graph, limit) })
    } catch (err) {
      next(err)
    }
  })

  const scenarioBody = z.object({
    airport_code: z.string().min(3).max(4),
    kind: z.enum(['FOG', 'ATC', 'TECH', 'RULE_CHANGE']).optional(),
    start_min: z.number().int().min(0).max(1440).optional(),
    end_min: z.number().int().min(0).max(1440).optional(),
    impact_min: z.number().int().min(0).max(600).optional(),
  })

  router.post('/stress', async (req, res, next) => {
    const parsed = scenarioBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: 'bad scenario', details: parsed.error.issues },
      })
      return
    }
    try {
      res.json(await stressTest(session.db, session.name, parsed.data))
    } catch (err) {
      next(err)
    }
  })

  const rerouteBody = z.object({
    origin: z.string().min(3).max(4),
    destination: z.string().min(3).max(4),
    after_min: z.number().int().min(0).max(1440),
  })

  router.post('/reroute', async (req, res, next) => {
    const parsed = rerouteBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: 'bad reroute request', details: parsed.error.issues },
      })
      return
    }
    try {
      const { origin, destination, after_min } = parsed.data
      res.json(
        await reroutePassengers(session.db, session.name, {
          origin,
          destination,
          afterMin: after_min,
        }),
      )
    } catch (err) {
      next(err)
    }
  })

  return router
}
