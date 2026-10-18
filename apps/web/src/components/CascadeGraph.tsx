'use client'

/**
 * The dependency graph — the view that carries the whole argument.
 *
 * Layout is deliberate and not a force simulation:
 *   x = scheduled departure time   (the operating day, left to right)
 *   y = one lane per aircraft      (a rotation reads as a horizontal line)
 *
 * So NEXT_LEG edges run flat along a lane (same aircraft, next leg) and
 * CREW_NEXT edges jump between lanes (crew changing aircraft). A viewer can
 * see the structure without being told it: delay enters on the left and walks
 * rightwards along the hand-offs, hopping lanes whenever crew carry it.
 *
 * Nothing here computes a delay. It renders snapshots the graph produced after
 * each relaxation wave.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CascadeReplay, FlightNode } from '@/lib/api'

interface Props {
  replay: CascadeReplay
  frame: number
  selected: string | null
  onSelect: (flightId: string) => void
  /** Flight ids on the evidence chain, drawn on top of everything. */
  chain?: string[]
}

const LANE_H = 30
const PAD_L = 92
const PAD_R = 28
const PAD_T = 34
const PAD_B = 28
const W = 1180

/** Colour a flight by how badly it is delayed. Presentation only. */
function delayColour(delay: number): string {
  if (delay <= 0) return '#2f3b4a'
  if (delay < 30) return '#4da3ff'
  if (delay < 60) return '#d29922'
  if (delay < 100) return '#f0883e'
  return '#f85149'
}

export function CascadeGraph({ replay, frame, selected, onSelect, chain = [] }: Props) {
  const { nodes, edges } = replay.graph
  const current = replay.frames[Math.min(frame, replay.frames.length - 1)]
  const delays = current?.delays ?? {}
  const cancelled = new Set(current?.cancelled ?? [])
  const chainSet = new Set(chain)

  // One lane per aircraft, ordered so lanes are stable across renders.
  const lanes = useMemo(() => {
    const tails = [...new Set(nodes.map((n) => n.tail))].sort()
    return new Map(tails.map((t, i) => [t, i]))
  }, [nodes])

  const { minT, maxT } = useMemo(() => {
    const times = nodes.flatMap((n) => [n.sched_dep, n.sched_arr])
    return { minT: Math.min(...times), maxT: Math.max(...times) }
  }, [nodes])

  const H = PAD_T + lanes.size * LANE_H + PAD_B

  const x = (minutes: number) =>
    PAD_L + ((minutes - minT) / (maxT - minT)) * (W - PAD_L - PAD_R)
  const y = (tail: string) => PAD_T + (lanes.get(tail) ?? 0) * LANE_H + LANE_H / 2

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  // Hour gridlines across the operating day.
  const hours: number[] = []
  for (let h = Math.ceil(minT / 60) * 60; h <= maxT; h += 120) hours.push(h)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Flight dependency graph">
      <rect x="0" y="0" width={W} height={H} fill="var(--panel-2)" rx="6" />

      {hours.map((h) => (
        <g key={h}>
          <line x1={x(h)} y1={PAD_T - 10} x2={x(h)} y2={H - PAD_B} stroke="#1f2a37" strokeWidth="1" />
          <text x={x(h)} y={PAD_T - 16} fontSize="9" fill="#5d6b7d" textAnchor="middle" className="mono">
            {String(Math.floor(h / 60)).padStart(2, '0')}:00
          </text>
        </g>
      ))}

      {[...lanes.entries()].map(([tail, i]) => (
        <g key={tail}>
          <line
            x1={PAD_L}
            y1={PAD_T + i * LANE_H + LANE_H / 2}
            x2={W - PAD_R}
            y2={PAD_T + i * LANE_H + LANE_H / 2}
            stroke="#18222e"
            strokeWidth="1"
          />
          <text x={8} y={PAD_T + i * LANE_H + LANE_H / 2 + 3} fontSize="10" fill="#8b9bb0" className="mono">
            {tail}
          </text>
        </g>
      ))}

      {/* Hand-off edges. CREW_NEXT jumps lanes, so it is drawn as a curve. */}
      {edges.map((e, i) => {
        const a = byId.get(e.source)
        const b = byId.get(e.target)
        if (!a || !b) return null

        const x1 = x(a.sched_arr)
        const y1 = y(a.tail)
        const x2 = x(b.sched_dep)
        const y2 = y(b.tail)

        const onChain = chainSet.has(e.source) && chainSet.has(e.target)
        // An edge "fired" when the delay arriving at it exceeded its slack.
        const fired = (delays[e.source] ?? 0) > e.slack_min
        const thin = e.slack_min <= 10

        const stroke = onChain ? '#ffffff' : fired ? '#f85149' : thin ? '#5a4420' : '#26323f'
        const width = onChain ? 2.6 : fired ? 1.8 : 1

        const path =
          e.kind === 'CREW_NEXT'
            ? `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
            : `M ${x1} ${y1} L ${x2} ${y2}`

        return (
          <path
            key={`${e.source}-${e.target}-${e.kind}-${i}`}
            d={path}
            fill="none"
            stroke={stroke}
            strokeWidth={width}
            strokeDasharray={e.kind === 'CREW_NEXT' ? '4 3' : undefined}
            opacity={onChain ? 1 : fired ? 0.95 : 0.6}
          >
            <title>{`${e.kind === 'NEXT_LEG' ? 'same aircraft' : 'same crew'}  ${e.source} → ${e.target}\nslack ${e.slack_min} min${fired ? '  — delay exceeded this slack' : ''}`}</title>
          </path>
        )
      })}

      {/* Flights, drawn as bars from departure to arrival. */}
      {nodes.map((n) => {
        const delay = delays[n.id] ?? 0
        const isCancelled = cancelled.has(n.id)
        const onChain = chainSet.has(n.id)
        const isSelected = selected === n.id
        const x1 = x(n.sched_dep)
        const x2 = x(n.sched_arr)

        return (
          <g key={n.id} onClick={() => onSelect(n.id)} style={{ cursor: 'pointer' }}>
            <rect
              x={x1}
              y={y(n.tail) - 6}
              width={Math.max(4, x2 - x1)}
              height={12}
              rx={3}
              fill={isCancelled ? '#3a1f22' : delayColour(delay)}
              stroke={onChain ? '#ffffff' : isSelected ? '#e6edf3' : 'none'}
              strokeWidth={onChain || isSelected ? 1.8 : 0}
              opacity={isCancelled ? 0.55 : 1}
            />
            {isCancelled && (
              <line
                x1={x1}
                y1={y(n.tail)}
                x2={x2}
                y2={y(n.tail)}
                stroke="#f85149"
                strokeWidth="1.6"
              />
            )}
            <title>
              {`${n.no}  ${n.dep}→${n.arr}\n${isCancelled ? 'CANCELLED' : delay > 0 ? `+${delay} min delay` : 'on time'}\n${n.pax} pax · ${n.tail} · ${n.crew}`}
            </title>
          </g>
        )
      })}
    </svg>
  )
}

/** Playback controls + the wave counter. */
export function ReplayControls({
  replay,
  frame,
  setFrame,
}: {
  replay: CascadeReplay
  frame: number
  setFrame: (n: number) => void
}) {
  const [playing, setPlaying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const last = replay.frames.length - 1

  useEffect(() => {
    if (!playing) return
    if (frame >= last) {
      setPlaying(false)
      return
    }
    timer.current = setTimeout(() => setFrame(frame + 1), 1100)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [playing, frame, last, setFrame])

  const current = replay.frames[frame]
  const affectedNow = Object.keys(current?.delays ?? {}).length

  // Before any cascade has been traced there is a single quiet frame: the
  // schedule as published. Nothing to play yet, so say so rather than offering
  // a control that would do nothing.
  if (replay.frames.length <= 1) {
    return (
      <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
        The schedule as published — no disruption applied. Trace a cascade above to watch delay
        propagate through these hand-offs, one wave at a time.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
      <button
        onClick={() => {
          if (frame >= last) setFrame(0)
          setPlaying(!playing)
        }}
      >
        {playing ? '❚❚ Pause' : frame >= last ? '↻ Replay cascade' : '▶ Play cascade'}
      </button>

      <input
        type="range"
        min={0}
        max={last}
        value={frame}
        onChange={(e) => {
          setPlaying(false)
          setFrame(Number(e.target.value))
        }}
        style={{ flex: 1, minWidth: 180, accentColor: 'var(--accent)' }}
      />

      <div className="mono" style={{ fontSize: 13, minWidth: 310 }}>
        {frame === 0 ? (
          <>
            <span className="warn">Wave 0</span> — shock lands on{' '}
            <strong>{replay.seeded}</strong> flights
          </>
        ) : (
          <>
            <span className={current?.changed === 0 ? 'ok' : 'warn'}>Wave {frame}</span>
            {current?.changed === 0 ? (
              <> — fixpoint, nothing more can spill</>
            ) : (
              <> — {current?.changed} more flights pushed</>
            )}
          </>
        )}
        <span className="muted"> · {affectedNow} affected</span>
      </div>
    </div>
  )
}
