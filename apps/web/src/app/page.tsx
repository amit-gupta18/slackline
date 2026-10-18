'use client'

/**
 * Phase 3 — the operator view.
 *
 * Flow: trace a cascade -> see it on the map -> ask why any flight is late ->
 * see graph-derived plans, verified or rejected -> a HUMAN confirms the commit.
 *
 * This component renders API responses. It performs no domain arithmetic: the
 * only numbers it produces itself are list lengths.
 */

import { useCallback, useEffect, useState } from 'react'
import { NetworkMap } from '@/components/NetworkMap'
import { CascadeGraph, ReplayControls } from '@/components/CascadeGraph'
import { EvidencePanel } from '@/components/EvidencePanel'
import { StressPanel } from '@/components/StressPanel'
import {
  api,
  ApiError,
  type AffectedFlight,
  type CascadeReplay,
  type Evaluation,
  type EvidencePath,
  type FragileHandoff,
} from '@/lib/api'

const DISRUPTION_ID = 'disruption-fog-del'

export default function Page() {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.state>> | null>(null)
  const [affected, setAffected] = useState<AffectedFlight[]>([])
  const [waves, setWaves] = useState<number[]>([])
  const [seeded, setSeeded] = useState<number | null>(null)
  const [fragile, setFragile] = useState<FragileHandoff[]>([])

  const [replay, setReplay] = useState<CascadeReplay | null>(null)
  const [frame, setFrame] = useState(0)

  const [selected, setSelected] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<EvidencePath | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [evidenceError, setEvidenceError] = useState<string | null>(null)

  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [best, setBest] = useState<Evaluation | null>(null)
  const [decisionId, setDecisionId] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ id: string; new_rev: number } | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const show = (err: unknown) =>
    setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))

  const refreshState = useCallback(async () => {
    try {
      setState(await api.state())
    } catch (err) {
      show(err)
    }
  }, [])

  useEffect(() => {
    void refreshState()
    api.readCascade().then((r) => setAffected(r.affected)).catch(() => {})
    api.fragile(10).then((r) => setFragile(r.handoffs)).catch(() => {})

    // Show the dependency structure straight away, before any cascade is run.
    // A single quiet frame with no delays: the schedule as published. Cheap —
    // this reads the graph, it does not fork or propagate anything.
    api
      .graph()
      .then((g) => {
        setReplay({ graph: g, frames: [{ wave: 0, changed: 0, delays: {}, cancelled: [] }], seeded: 0 })
        setFrame(0)
      })
      .catch(() => {})
  }, [refreshState])

  async function traceCascade() {
    setBusy('cascade')
    setError(null)
    setEvaluations([])
    setBest(null)
    setDecisionId(null)
    setReceipt(null)
    try {
      const result = await api.traceCascade(DISRUPTION_ID)
      setAffected(result.affected)
      setWaves(result.waves)
      setSeeded(result.seeded)

      // Capture the wave-by-wave replay so the propagation can be watched
      // rather than just reported. Runs on a fork; the live graph is untouched.
      const r = await api.replay(DISRUPTION_ID)
      setReplay(r)
      setFrame(r.frames.length - 1) // land on the finished cascade

      const f = await api.fragile(10)
      setFragile(f.handoffs)
      await refreshState()
    } catch (err) {
      show(err)
    } finally {
      setBusy(null)
    }
  }

  async function selectFlight(flightId: string) {
    setSelected(flightId)
    setEvidence(null)
    setEvidenceError(null)

    // The root is the worst-delayed flight that departed the disrupted airport.
    const root = affected.find((f) => f.dep === 'DEL' && f.flight !== flightId)
    if (!root) {
      setEvidenceError('No seeded root flight available to trace from.')
      return
    }

    setEvidenceLoading(true)
    try {
      setEvidence(await api.evidence(flightId, root.flight))
    } catch (err) {
      setEvidenceError(
        err instanceof ApiError && err.code === 'NO_PATH'
          ? `No hand-off chain connects ${root.flight} to ${flightId} — this delay came from somewhere else.`
          : String(err),
      )
    } finally {
      setEvidenceLoading(false)
    }
  }

  async function evaluatePlans() {
    setBusy('evaluate')
    setError(null)
    try {
      const result = await api.evaluateAll(DISRUPTION_ID)
      setEvaluations(result.evaluations)
      setBest(result.best)
      setDecisionId(result.decision_id)
    } catch (err) {
      show(err)
    } finally {
      setBusy(null)
    }
  }

  async function confirmCommit() {
    if (!decisionId) return
    setBusy('commit')
    setError(null)
    try {
      const r = await api.commit(decisionId, DISRUPTION_ID)
      setReceipt({ id: r.id, new_rev: r.new_rev })
      const cascade = await api.readCascade()
      setAffected(cascade.affected)
      await refreshState()
    } catch (err) {
      show(err)
    } finally {
      setBusy(null)
    }
  }

  const baseline = evaluations.find((e) => e.plan.actions.length === 0)

  return (
    <>
      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="stat-row" style={{ alignItems: 'center' }}>
          <div className="stat">
            <div className="v">{state?.flights ?? '—'}</div>
            <div className="k">flights</div>
          </div>
          <div className="stat">
            <div className="v">{state?.aircraft ?? '—'}</div>
            <div className="k">aircraft</div>
          </div>
          <div className="stat">
            <div className="v">{state?.crew ?? '—'}</div>
            <div className="k">crew</div>
          </div>
          <div className="stat">
            <div className="v">{affected.length}</div>
            <div className="k">affected now</div>
          </div>
          <div className="stat">
            <div className="v">{state?.revision ?? '—'}</div>
            <div className="k">graph revision</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={traceCascade} disabled={busy !== null}>
              {busy === 'cascade' ? 'Tracing…' : 'Trace cascade (FOG at DEL)'}
            </button>
            <button className="secondary" onClick={evaluatePlans} disabled={busy !== null || affected.length === 0}>
              {busy === 'evaluate' ? 'Forking…' : 'Find containment plans'}
            </button>
          </div>
        </div>
        {seeded !== null && (
          <p className="source-note">
            {seeded} flights seeded directly · cascade reached fixpoint in {waves.length} relaxation
            wave{waves.length === 1 ? '' : 's'} (changes per wave: {waves.join(', ')})
          </p>
        )}
      </div>

      {replay && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>The dependency graph — watch the delay travel</h2>
          <p className="hint">
            One lane per aircraft, time runs left to right. <strong>Solid lines</strong> are the same
            aircraft flying its next leg; <strong>dashed curves</strong> are the same crew moving to
            another aircraft. A line turns <span className="bad">red</span> when the delay arriving
            at it exceeded its slack — that is the moment the buffer ran out and the delay spilled
            onward.
          </p>
          <ReplayControls replay={replay} frame={frame} setFrame={setFrame} />
          <div style={{ overflowX: 'auto' }}>
            <CascadeGraph
              replay={replay}
              frame={frame}
              selected={selected}
              onSelect={selectFlight}
              chain={evidence?.chain}
            />
          </div>
          <p className="source-note">
            Each wave is one execution of the relaxation query, replayed on a GRAPH.COPY fork. The
            run ends when a wave changes nothing — the cascade stops because no delay can spill
            further, not because we stopped looking.
          </p>
        </div>
      )}

      <div className="grid">
        <div className="panel">
          <h2>Geography</h2>
          <p className="hint">Click any route or row to trace why it is late.</p>
          <NetworkMap
            affected={affected}
            selected={selected}
            onSelect={selectFlight}
            highlightChain={evidence?.chain}
          />
        </div>

        <div className="panel">
          <h2>Affected flights</h2>
          <p className="hint">Ordered by delay, tie-broken by flight id — deterministic.</p>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>Route</th>
                  <th>Delay</th>
                  <th>Pax</th>
                </tr>
              </thead>
              <tbody>
                {affected.map((f) => (
                  <tr
                    key={f.flight}
                    className={`clickable ${selected === f.flight ? 'selected' : ''}`}
                    onClick={() => selectFlight(f.flight)}
                  >
                    <td className="mono">{f.no}</td>
                    <td className="mono muted">{f.dep}→{f.arr}</td>
                    <td className={f.delay >= 90 ? 'bad' : f.delay >= 30 ? 'warn' : ''}>
                      +{f.delay}
                    </td>
                    <td className="muted">{f.pax}</td>
                  </tr>
                ))}
                {affected.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No cascade traced yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <EvidencePanel
          flightId={selected}
          path={evidence}
          loading={evidenceLoading}
          error={evidenceError}
        />
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Containment plans</h2>
          <p className="hint">
            Every plan was built from graph-returned candidates, then tested on its own GRAPH.COPY
            fork. A rejected plan shows the invariant that stopped it.
          </p>

          {evaluations.length === 0 && <p className="muted">No plans evaluated yet.</p>}

          {evaluations.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Actions</th>
                  <th>Score</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((e) => (
                  <tr key={e.plan.id} className={best?.plan.id === e.plan.id ? 'selected' : ''}>
                    <td className="mono">{e.plan.id}</td>
                    <td className="muted">
                      {e.plan.actions.length === 0
                        ? 'do nothing (baseline)'
                        : e.plan.actions.map((a) => String(a.type)).join(', ')}
                    </td>
                    <td>{e.score.score.toFixed(1)}</td>
                    <td>
                      {e.verified ? (
                        <span className="badge ok">VERIFIED</span>
                      ) : (
                        <span className="badge bad" title={e.violations[0]?.message}>
                          {e.violations[0]?.invariant ?? 'REJECTED'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {best && baseline && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <div className="stat-row">
                <div className="stat">
                  <div className="v">{baseline.score.score.toFixed(1)}</div>
                  <div className="k">do nothing</div>
                </div>
                <div className="stat">
                  <div className="v ok">{best.score.score.toFixed(1)}</div>
                  <div className="k">best verified plan</div>
                </div>
                <div className="stat">
                  <div className="v">{best.score.pax_cancelled}</div>
                  <div className="k">pax cancelled</div>
                </div>
                <div className="stat">
                  <div className="v">{best.score.worst_delay}</div>
                  <div className="k">worst delay after</div>
                </div>
              </div>

              <p className="source-note">
                Score = pax_cancelled×3 + passenger-hours of delay×1. These weights are a declared
                heuristic, not a derived optimum. Only verified plans are ranked — a rejected plan
                may score lower and is still never chosen.
              </p>

              {!receipt ? (
                <button onClick={confirmCommit} disabled={busy !== null || !decisionId}>
                  {busy === 'commit' ? 'Committing…' : `Confirm & commit ${best.plan.id}`}
                </button>
              ) : (
                <p className="ok">
                  Committed. Receipt <span className="mono">{receipt.id}</span>, graph revision now{' '}
                  {receipt.new_rev}.
                </p>
              )}
              <p className="source-note">
                A human clicks this. Nothing commits automatically, and a decision verified against
                an older graph revision is refused.
              </p>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Fragile hand-offs</h2>
          <p className="hint">
            Thin slack sitting in front of a large downstream blast radius. blast radius = flights
            reachable downstream, not betweenness centrality.
          </p>
          <table>
            <thead>
              <tr>
                <th>Hand-off</th>
                <th>Type</th>
                <th>Slack</th>
                <th>Blast</th>
                <th>Pax at risk</th>
              </tr>
            </thead>
            <tbody>
              {fragile.map((h) => (
                <tr key={`${h.from_flight}-${h.to_flight}-${h.kind}`}>
                  <td className="mono">
                    {h.from_flight}→{h.to_flight}
                  </td>
                  <td className="muted">{h.kind === 'NEXT_LEG' ? 'aircraft' : 'crew'}</td>
                  <td className={h.slack_min <= 10 ? 'bad' : ''}>{h.slack_min}</td>
                  <td>{h.blast_radius}</td>
                  <td className="muted">{h.pax_at_risk}</td>
                </tr>
              ))}
              {fragile.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Start the API and reload.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <StressPanel />
      </div>
    </>
  )
}
