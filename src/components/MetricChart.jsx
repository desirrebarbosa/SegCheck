import { useMemo } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { defaultChartConfig, runSeriesKeys } from '../lib/runSeries'

// The per-epoch training curve, drawn from an experiment's run log.
//
// Recharts' own palette and chrome are overridden throughout — the point is
// for this to look like the rest of SegCheck, not like a charting library
// dropped into it. Series colours, grid and tick colours all come from the
// hexes already used across src/, and the stroke weight matches the
// sparkline in ProjectsList.jsx.
const SERIES_COLORS = ['#D85A30', '#3D6EB0', '#639922', '#791F1F', '#7A4A12']

const GRID = '#E5E4DF'
const MUTED = '#888780'

function colorFor(key, allKeys) {
  return SERIES_COLORS[allKeys.indexOf(key) % SERIES_COLORS.length]
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[#E5E4DF] bg-white px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium text-[#1a1a1a]">Epoch {label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: p.color }}
            aria-hidden="true"
          />
          <span className="text-[#5F5E5A]">{p.name}</span>
          <span className="font-medium text-[#1a1a1a]">{p.value}</span>
        </p>
      ))}
    </div>
  )
}

export default function MetricChart({ runs, chart, height = 320 }) {
  const config = useMemo(() => chart ?? defaultChartConfig(runs), [chart, runs])
  const allKeys = useMemo(() => runSeriesKeys(runs), [runs])

  // Recharts wants one flat object per x value.
  const data = useMemo(
    () => (runs ?? []).map((r) => ({ epoch: r.epoch, ...(r.metrics ?? {}) })),
    [runs],
  )

  const left = config.left?.series ?? []
  const right = config.right?.series ?? []

  if (!data.length || (!left.length && !right.length)) {
    return (
      <p className="rounded-xl border border-dashed border-[#E5E4DF] p-6 text-center text-sm text-[#888780]">
        No run log yet — add epochs in the form, or import a JSON file, and the chart is
        drawn from them.
      </p>
    )
  }

  return (
    // A fixed pixel height rather than an aspect ratio: ResponsiveContainer
    // measures its parent, and inside a print layout or an off-screen
    // html-to-image render a percentage height collapses to zero.
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="epoch"
            stroke={GRID}
            tick={{ fill: MUTED, fontSize: 12 }}
            tickLine={false}
            label={{ value: 'epoch', position: 'insideBottom', offset: -4, fill: MUTED, fontSize: 12 }}
          />
          {left.length > 0 && (
            <YAxis
              yAxisId="left"
              stroke={GRID}
              tick={{ fill: MUTED, fontSize: 12 }}
              tickLine={false}
              width={52}
              label={
                config.left?.label
                  ? { value: config.left.label, angle: -90, position: 'insideLeft', fill: MUTED, fontSize: 12 }
                  : undefined
              }
            />
          )}
          {right.length > 0 && (
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={GRID}
              tick={{ fill: MUTED, fontSize: 12 }}
              tickLine={false}
              width={52}
              label={
                config.right?.label
                  ? { value: config.right.label, angle: 90, position: 'insideRight', fill: MUTED, fontSize: 12 }
                  : undefined
              }
            />
          )}
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12, color: MUTED }} iconType="plainline" />
          {left.map((key) => (
            <Line
              key={key}
              yAxisId="left"
              type="monotone"
              dataKey={key}
              stroke={colorFor(key, allKeys)}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {right.map((key) => (
            <Line
              key={key}
              yAxisId="right"
              type="monotone"
              dataKey={key}
              stroke={colorFor(key, allKeys)}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
