// Helpers for reading an experiment's run log. Deliberately free of any
// charting import: MetricChart is lazy-loaded so recharts stays out of the
// main bundle, and these are needed synchronously by the run-log editor and
// by the JSON export, neither of which should drag the library in.

// Every numeric column present anywhere in the log, in first-seen order.
export function runSeriesKeys(runs) {
  const keys = []
  for (const r of runs ?? []) {
    for (const k of Object.keys(r.metrics ?? {})) {
      if (!keys.includes(k)) keys.push(k)
    }
  }
  return keys
}

// Used when a run log arrives without a chart block. Losses and metrics live
// on wildly different ranges — a loss of 2.4 against a mAP of 40 flattens the
// loss curve into the axis — so they are split onto two axes by name.
export function defaultChartConfig(runs) {
  const keys = runSeriesKeys(runs)
  const left = keys.filter((k) => /loss|lr|error/i.test(k))
  const right = keys.filter((k) => !left.includes(k))
  return {
    left: { label: left.length ? 'loss' : '', series: left },
    right: { label: right.length ? 'metric (%)' : '', series: right },
  }
}
