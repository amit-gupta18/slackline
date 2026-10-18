'use client'

/**
 * Stress-test mode — "what would break if this happened?"
 *
 * Runs entirely on a fork server-side, so it is safe to run against the live
 * operating state. It proposes nothing: it reports where the schedule ran out
 * of buffer, which is a different and more honest question.
 */

import { useState } from 'react'
import { api, ApiError, AIRPORTS } from '@/lib/api'

type Result = Awaited<ReturnType<typeof api.stress>>

export function StressPanel() {
  const [airport, setAirport] = useState('BOM')
  const [impact, setImpact] = useState(120)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.stress(airport, impact))
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h2>Stress test — what if?</h2>
      <p className="hint">
        A hypothetical disruption, run on a throwaway fork. The live graph is never touched.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select
          value={airport}
          onChange={(e) => setAirport(e.target.value)}
          style={{
            background: 'var(--panel-2)',
            color: 'var(--text)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 13,
          }}
        >
          {Object.entries(AIRPORTS).map(([code, a]) => (
            <option key={code} value={code}>
              {code} — {a.city}
            </option>
          ))}
        </select>

        <label className="muted" style={{ fontSize: 12 }}>
          impact
          <input
            type="number"
            value={impact}
            min={0}
            max={600}
            step={30}
            onChange={(e) => setImpact(Number(e.target.value))}
            style={{
              background: 'var(--panel-2)',
              color: 'var(--text)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 13,
              width: 80,
              marginLeft: 6,
            }}
          />{' '}
          min
        </label>

        <button className="secondary" onClick={run} disabled={busy}>
          {busy ? 'Forking…' : 'Run scenario'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {result && (
        <>
          <div className="stat-row" style={{ marginBottom: 12 }}>
            <div className="stat">
              <div className="v">{result.affected}</div>
              <div className="k">flights affected</div>
            </div>
            <div className="stat">
              <div className="v">{result.worst_delay}</div>
              <div className="k">worst delay (min)</div>
            </div>
            <div className="stat">
              <div className={`v ${result.breakages.length > 0 ? 'bad' : 'ok'}`}>
                {result.breakages.length}
              </div>
              <div className="k">invariants broken</div>
            </div>
          </div>

          {result.breakages.length > 0 && (
            <p className="bad" style={{ fontSize: 13 }}>
              {result.breakages.map((b) => `${b.invariant} ${b.message}`).join(' · ')}
            </p>
          )}

          <h2 style={{ marginTop: 14 }}>Where the buffer ran out</h2>
          <table>
            <thead>
              <tr>
                <th>Hand-off</th>
                <th>Type</th>
                <th>Slack</th>
                <th>Short by</th>
                <th>Pax</th>
              </tr>
            </thead>
            <tbody>
              {result.missing_slack.slice(0, 8).map((m) => (
                <tr key={`${m.from_flight}-${m.to_flight}-${m.kind}`}>
                  <td className="mono">
                    {m.from_flight}→{m.to_flight}
                  </td>
                  <td className="muted">{m.kind === 'NEXT_LEG' ? 'aircraft' : 'crew'}</td>
                  <td>{m.slack_min}</td>
                  <td className="bad">−{m.slack_short_by}</td>
                  <td className="muted">{m.pax_affected}</td>
                </tr>
              ))}
              {result.missing_slack.length === 0 && (
                <tr>
                  <td colSpan={5} className="ok">
                    Every hand-off absorbed it. This scenario does not cascade.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="source-note">
            &ldquo;Short by&rdquo; is how many more minutes of buffer that hand-off would have
            needed to stop the delay there.
          </p>
        </>
      )}
    </div>
  )
}
