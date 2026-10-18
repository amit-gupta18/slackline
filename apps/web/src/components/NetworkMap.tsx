'use client'

/**
 * The map. Inline SVG, equirectangular projection of the airport coordinates —
 * no mapping library, no tile server, nothing to load.
 *
 * It renders delays the API returned. It does not compute a delay, a colour
 * threshold over domain data, or anything else the graph should own.
 */

import { AIRPORTS, type AffectedFlight } from '@/lib/api'

interface Props {
  affected: AffectedFlight[]
  selected: string | null
  onSelect: (flightId: string) => void
  /** Flight ids on the currently displayed evidence chain. */
  highlightChain?: string[]
}

const W = 560
const H = 460
const PAD = 44

const lons = Object.values(AIRPORTS).map((a) => a.lon)
const lats = Object.values(AIRPORTS).map((a) => a.lat)
const minLon = Math.min(...lons)
const maxLon = Math.max(...lons)
const minLat = Math.min(...lats)
const maxLat = Math.max(...lats)

function project(lat: number, lon: number): [number, number] {
  const x = PAD + ((lon - minLon) / (maxLon - minLon)) * (W - PAD * 2)
  // Latitude increases northward; SVG y increases downward.
  const y = PAD + ((maxLat - lat) / (maxLat - minLat)) * (H - PAD * 2)
  return [x, y]
}

/** Colour by delay severity. Presentation only — the number came from a query. */
function severity(delay: number): string {
  if (delay >= 90) return 'var(--bad)'
  if (delay >= 30) return 'var(--warn)'
  return 'var(--accent)'
}

export function NetworkMap({ affected, selected, onSelect, highlightChain = [] }: Props) {
  const chain = new Set(highlightChain)

  // Worst delay per airport pair, so overlapping routes do not hide each other.
  const routes = new Map<string, AffectedFlight>()
  for (const f of affected) {
    const key = `${f.dep}-${f.arr}`
    const existing = routes.get(key)
    if (!existing || f.delay > existing.delay) routes.set(key, f)
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Network map of affected flights">
      <rect x="0" y="0" width={W} height={H} fill="var(--panel-2)" rx="6" />

      {[...routes.values()].map((f) => {
        const from = AIRPORTS[f.dep]
        const to = AIRPORTS[f.arr]
        if (!from || !to) return null
        const [x1, y1] = project(from.lat, from.lon)
        const [x2, y2] = project(to.lat, to.lon)
        const onChain = chain.has(f.flight)
        const isSelected = selected === f.flight

        return (
          <line
            key={f.flight}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={onChain ? '#ffffff' : severity(f.delay)}
            strokeWidth={isSelected || onChain ? 2.4 : 1.1}
            strokeOpacity={onChain || isSelected ? 1 : 0.45}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(f.flight)}
          >
            <title>{`${f.no}  ${f.dep}→${f.arr}  +${f.delay} min  ${f.pax} pax`}</title>
          </line>
        )
      })}

      {Object.entries(AIRPORTS).map(([code, a]) => {
        const [x, y] = project(a.lat, a.lon)
        return (
          <g key={code}>
            <circle cx={x} cy={y} r={3.5} fill="var(--text)" />
            <text x={x + 7} y={y + 4} fontSize="10" fill="var(--muted)" className="mono">
              {code}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
