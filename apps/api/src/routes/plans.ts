/**
 * Candidate, evaluate and commit routes.
 *
 * The commit route is the ONLY write path in the entire API, and it takes only
 * a decision id from the URL. It never accepts a plan body — that is the
 * structural guarantee that no caller can act on something the graph did not
 * verify.
 */

import { Router } from 'express'
import { z } from 'zod'
import {
  buildPlans,
  chooseBest,
  commitDecision,
  evaluateAll,
  evaluatePlan,
  findCandidates,
  scorePlan,
  StaleDecisionError,
  writeDecision,
  type Session,
} from '@slackline/graph'

/**
 * The fixed action menu, mirrored as a zod schema. An action outside this
 * union cannot enter the system.
 */
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CANCEL_PAIR'), legs: z.tuple([z.string(), z.string()]) }),
  z.object({ type: z.literal('SWAP_TAIL'), flight: z.string(), to_aircraft: z.string() }),
  z.object({ type: z.literal('SWAP_CREW'), flight: z.string(), to_crew: z.string() }),
  z.object({ type: z.literal('ABSORB'), flight: z.string() }),
])

const planSchema = z.object({ id: z.string().min(1), actions: z.array(actionSchema) })

export function planRoutes(session: Session): Router {
  const router = Router()

  router.get('/candidates', async (req, res, next) => {
    const threshold = Number(req.query.threshold ?? 0)
    try {
      const candidates = await findCandidates(session.graph, { threshold })
      res.json({ candidates, plans: buildPlans(candidates) })
    } catch (err) {
      next(err)
    }
  })

  const evaluateBody = z.object({
    disruption_id: z.string().min(1),
    plan: planSchema.optional(),
  })

  /**
   * Evaluate one plan, or every graph-derived plan when none is supplied.
   * A plan that fails the invariants returns 200 with verified:false — a
   * rejection is a successful evaluation, not an error.
   */
  router.post('/evaluate', async (req, res, next) => {
    const parsed = evaluateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_BODY', message: 'bad plan or disruption_id', details: parsed.error.issues },
      })
      return
    }

    try {
      const { disruption_id, plan } = parsed.data

      if (plan) {
        res.json(await evaluatePlan(session.db, session.name, plan, { disruptionId: disruption_id }))
        return
      }

      const candidates = await findCandidates(session.graph, { threshold: 0 })
      const evaluations = await evaluateAll(session.db, session.name, buildPlans(candidates), {
        disruptionId: disruption_id,
      })
      const best = chooseBest(evaluations)

      let decisionId: string | null = null
      if (best) {
        decisionId = `decision-${Date.now().toString(36)}`
        await writeDecision(session.graph, {
          id: decisionId,
          cascadeRoot: '',
          plan: best.plan,
          evidence: {},
          score: await scorePlan(session.graph),
          affected: [],
        })
      }

      res.json({ evaluations, best, decision_id: decisionId })
    } catch (err) {
      next(err)
    }
  })

  /** THE ONLY WRITER. Takes a decision id and nothing else. */
  router.post('/:decisionId/commit', async (req, res, next) => {
    const body = z.object({ disruption_id: z.string().min(1) }).safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: { code: 'INVALID_BODY', message: 'disruption_id is required' } })
      return
    }

    try {
      const receipt = await commitDecision(session.graph, req.params.decisionId, {
        disruptionId: body.data.disruption_id,
      })
      res.json(receipt)
    } catch (err) {
      // A stale decision is a refusal, not a crash: 409, with the reason.
      if (err instanceof StaleDecisionError) {
        res.status(409).json({
          error: {
            code: 'STALE_DECISION',
            message: err.message,
            details: { decision_rev: err.decisionRev, current_rev: err.currentRev },
          },
        })
        return
      }
      next(err)
    }
  })

  return router
}
