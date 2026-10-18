/**
 * Read-only network routes. Every figure comes from a query result.
 */

import { Router } from 'express'
import { z } from 'zod'
import {
  explainDelay,
  exportGraph,
  queries,
  readCascade,
  replayCascade,
  run,
  traceCascade,
  type Session,
} from '@slackline/graph'

export function networkRoutes(session: Session): Router {
  const router = Router()

  router.get('/state', async (_req, res, next) => {
    try {
      const rows = await run(session.graph, queries.NETWORK_STATE)
      res.json(rows[0] ?? null)
    } catch (err) {
      next(err)
    }
  })

  const cascadeBody = z.object({ disruption_id: z.string().min(1) })

  router.post('/cascade', async (req, res, next) => {
    const parsed = cascadeBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: 'disruption_id is required', details: parsed.error.issues },
      })
      return
    }
    try {
      res.json(await traceCascade(session.graph, parsed.data.disruption_id))
    } catch (err) {
      next(err)
    }
  })

  router.get('/cascade', async (_req, res, next) => {
    try {
      res.json({ affected: await readCascade(session.graph) })
    } catch (err) {
      next(err)
    }
  })

  /** The dependency graph itself — flights and the hand-offs between them. */
  router.get('/graph', async (_req, res, next) => {
    try {
      res.json(await exportGraph(session.graph))
    } catch (err) {
      next(err)
    }
  })

  /**
   * Cascade replay: the graph plus one delay snapshot per relaxation wave.
   * Runs on a fork, so it never disturbs the live graph.
   */
  router.post('/replay', async (req, res, next) => {
    const parsed = cascadeBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: 'disruption_id is required' },
      })
      return
    }
    try {
      res.json(await replayCascade(session.db, session.name, parsed.data.disruption_id))
    } catch (err) {
      next(err)
    }
  })

  /** "Why is this flight late?" — the evidence chain. */
  router.get('/flights/:id/evidence', async (req, res, next) => {
    const root = z.string().min(1).safeParse(req.query.root)
    if (!root.success) {
      res.status(400).json({ error: { code: 'INVALID_QUERY', message: '?root=<flight id> is required' } })
      return
    }
    try {
      const path = await explainDelay(session.graph, root.data, req.params.id)
      if (!path) {
        res.status(404).json({
          error: {
            code: 'NO_PATH',
            message: `no hand-off chain connects ${root.data} to ${req.params.id} — its delay did not come from there`,
          },
        })
        return
      }
      res.json(path)
    } catch (err) {
      next(err)
    }
  })

  return router
}
