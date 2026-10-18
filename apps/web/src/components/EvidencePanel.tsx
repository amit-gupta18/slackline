'use client'

/**
 * The evidence panel — the reason this project exists.
 *
 * "Why is this flight late?" answered with the literal chain of hand-offs and
 * the slack at each one. Nothing here is generated prose: every token comes
 * from the EVIDENCE_PATH query result.
 */

import type { EvidencePath } from '@/lib/api'

interface Props {
  flightId: string | null
  path: EvidencePath | null
  loading: boolean
  error: string | null
}

export function EvidencePanel({ flightId, path, loading, error }: Props) {
  return (
    <div className="panel">
      <h2>Evidence — why is this flight late?</h2>
      <p className="hint">
        The chain of hand-offs the delay actually travelled, with the slack it ate at each hop.
      </p>

      {!flightId && <p className="muted">Select a delayed flight to trace its cause.</p>}
      {loading && <p className="muted">Tracing…</p>}
      {error && <div className="error">{error}</div>}

      {path && !loading && (
        <>
          <div className="chain">
            {path.chain.map((id, i) => (
              <span key={`${id}-${i}`} style={{ display: 'contents' }}>
                <span className="node">{id}</span>
                {i < path.hop_types.length && (
                  <span className="hop">
                    <div>{path.hop_types[i] === 'NEXT_LEG' ? 'same aircraft' : 'same crew'}</div>
                    <div>
                      slack{' '}
                      <span className={(path.slack_at_each_hop[i] ?? 0) <= 10 ? 'slack-thin' : ''}>
                        {path.slack_at_each_hop[i]} min
                      </span>
                    </div>
                    <div>→</div>
                  </span>
                )}
              </span>
            ))}
          </div>

          <p className="source-note">
            {path.hops} hop{path.hops === 1 ? '' : 's'}. A hand-off with slack at or below 10 minutes
            is shown in red: that is where the schedule had no buffer left to absorb the delay.
          </p>
        </>
      )}
    </div>
  )
}
