import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseExperimentJson, exportExperimentJson } from './experimentImport.js'

const MEMBERS = [
  { id: 'r1', email: 'rlgarces@up.edu.ph', display_name: 'RL Garces' },
  { id: 'r2', email: 'gian@up.edu.ph', display_name: 'Gian' },
]

const OPTS = { members: MEMBERS, defaultAddedBy: 'r2' }

function valid(overrides = {}) {
  return {
    title: 'exp 01 vit only',
    tasks: ['object_detection'],
    epochs: 3,
    added_by: 'rlgarces@up.edu.ph',
    performance: { mAP50: 40.2, mIoU: 70.3 },
    runs: [
      { epoch: 1, train_loss: 2.41, mAP50: 11.2 },
      { epoch: 2, train_loss: 1.92, mAP50: 19.4 },
    ],
    ...overrides,
  }
}

describe('parseExperimentJson', () => {
  it('accepts the shipped template file', () => {
    const raw = readFileSync(
      new URL('../../../segcheck-md/experiment-import-template.json', import.meta.url),
      'utf8',
    )
    const result = parseExperimentJson(raw, OPTS)
    expect(result.errors).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.experiment).toMatchObject({
      title: 'exp 01 vit only',
      run_date: '2026-09-05',
      tasks: ['object_detection'],
      epochs: 50,
      added_by: 'r1',
      color_space: 'RGB',
      backbone: 'ViT-B/16',
      neck: 'FPN',
      heads: ['Faster R-CNN head'],
      map_50: 40.2,
      map_avg: 20.1,
      miou: 70.3,
      f1: 64.8,
    })
    expect(result.runs).toHaveLength(10)
    expect(result.chart.left.series).toEqual(['train_loss', 'val_loss'])
    expect(result.chart.right.series).toEqual(['mAP50', 'mIoU'])
  })

  it('reports a syntax error rather than crashing', () => {
    const result = parseExperimentJson('{ "title": ', OPTS)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/Not valid JSON/)
  })

  it('collects every problem at once instead of stopping at the first', () => {
    const result = parseExperimentJson(
      {
        tasks: ['segmentation'],
        epochs: -4,
        added_by: 'nobody@example.com',
        performance: { mAP50: 140 },
        runs: [{ epoch: 1 }, { epoch: 1 }],
      },
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(6)
    expect(result.errors.join('\n')).toMatch(/"title" is required/)
    expect(result.errors.join('\n')).toMatch(/Unknown task "segmentation"/)
    expect(result.errors.join('\n')).toMatch(/"epochs" must be a positive whole number/)
    expect(result.errors.join('\n')).toMatch(/is not a member of this project/)
    expect(result.errors.join('\n')).toMatch(/outside 0–100/)
    expect(result.errors.join('\n')).toMatch(/repeats epoch 1/)
  })

  it('names the valid members when added_by does not match', () => {
    const result = parseExperimentJson(valid({ added_by: 'nope@example.com' }), OPTS)
    expect(result.errors[0]).toMatch(/rlgarces@up\.edu\.ph, gian@up\.edu\.ph/)
  })

  it('matches a member by email, display name or id', () => {
    for (const who of ['rlgarces@up.edu.ph', 'RL Garces', 'r1']) {
      const result = parseExperimentJson(valid({ added_by: who }), OPTS)
      expect(result.ok).toBe(true)
      expect(result.experiment.added_by).toBe('r1')
    }
  })

  it('falls back to the signed-in user when added_by is absent', () => {
    const doc = valid()
    delete doc.added_by
    expect(parseExperimentJson(doc, OPTS).experiment.added_by).toBe('r2')
  })

  it('normalises human task spellings', () => {
    const result = parseExperimentJson(
      valid({ tasks: ['Object Detection', 'instance-segmentation'] }),
      OPTS,
    )
    expect(result.ok).toBe(true)
    expect(result.experiment.tasks).toEqual(['object_detection', 'instance_segmentation'])
  })

  it('rejects more than two tasks', () => {
    const result = parseExperimentJson(
      valid({
        tasks: ['object_detection', 'semantic_segmentation', 'instance_segmentation'],
      }),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/at most two/)
  })

  it('scales unit metrics to percent and range-checks against the declared scale', () => {
    const ok = parseExperimentJson(
      valid({ metric_scale: 'unit', performance: { mAP50: 0.402, mIoU: 0.703 } }),
      OPTS,
    )
    expect(ok.ok).toBe(true)
    expect(ok.experiment.map_50).toBe(40.2)
    expect(ok.experiment.miou).toBe(70.3)

    const bad = parseExperimentJson(
      valid({ metric_scale: 'unit', performance: { mAP50: 40.2 } }),
      OPTS,
    )
    expect(bad.ok).toBe(false)
    expect(bad.errors[0]).toMatch(/outside 0–1 for metric_scale "unit"/)
  })

  it('warns about unknown keys rather than failing the import', () => {
    const result = parseExperimentJson(
      valid({
        colour: 'blue',
        architecture: { backbone: 'ViT-B/16', wibble: 1 },
        performance: { mAP50: 40.2, mAP99: 1 },
        runs: [{ epoch: 1, mAP50: 11.2, note: 'best so far' }],
      }),
      OPTS,
    )
    expect(result.ok).toBe(true)
    expect(result.warnings.join('\n')).toMatch(/unknown top-level key "colour"/)
    expect(result.warnings.join('\n')).toMatch(/unknown architecture key "wibble"/)
    expect(result.warnings.join('\n')).toMatch(/unknown performance key "mAP99"/)
    expect(result.warnings.join('\n')).toMatch(/Dropped non-numeric run column\(s\): note/)
    expect(result.runs[0].metrics).toEqual({ mAP50: 11.2 })
  })

  it('drops chart series that no run row provides', () => {
    const result = parseExperimentJson(
      valid({
        chart: { left: { label: 'loss', series: ['train_loss', 'ghost'] } },
      }),
      OPTS,
    )
    expect(result.ok).toBe(true)
    expect(result.chart.left.series).toEqual(['train_loss'])
    expect(result.warnings.join('\n')).toMatch(/names "ghost"/)
  })

  it('sorts runs by epoch and infers epochs from the log when absent', () => {
    const doc = valid({ runs: [{ epoch: 9, mAP50: 3 }, { epoch: 2, mAP50: 1 }] })
    delete doc.epochs
    const result = parseExperimentJson(doc, OPTS)
    expect(result.runs.map((r) => r.epoch)).toEqual([2, 9])
    expect(result.experiment.epochs).toBe(9)
  })

  it('allows an experiment with no run log at all', () => {
    const doc = valid()
    delete doc.runs
    const result = parseExperimentJson(doc, OPTS)
    expect(result.ok).toBe(true)
    expect(result.runs).toEqual([])
    expect(result.chart).toBeNull()
  })

  it('rejects a bad date instead of silently using today', () => {
    const result = parseExperimentJson(valid({ date: '05/09/2026' }), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/must be YYYY-MM-DD/)
  })
})

describe('exportExperimentJson', () => {
  it('round-trips back through the importer', () => {
    const first = parseExperimentJson(valid({ chart: { left: { series: ['train_loss'] } } }), OPTS)
    const doc = exportExperimentJson(
      { ...first.experiment, added_by_email: 'rlgarces@up.edu.ph' },
      first.runs,
      first.chart,
    )
    const second = parseExperimentJson(JSON.stringify(doc), OPTS)
    expect(second.ok).toBe(true)
    expect(second.warnings).toEqual([])
    expect(second.experiment).toEqual(first.experiment)
    expect(second.runs).toEqual(first.runs)
  })

  it('omits the chart block when there is nothing to plot', () => {
    const doc = exportExperimentJson({ title: 'x', run_date: '2026-01-01', tasks: [] }, [], null)
    expect(doc.chart).toBeUndefined()
    expect(doc.runs).toEqual([])
  })
})
