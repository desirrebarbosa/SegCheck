import { supabase } from './supabaseClient'

// Cycled through for any class that hasn't been explicitly assigned a color
// yet, so the overlay never falls back to a single flat default.
const DEFAULT_PALETTE = [
  { bbox: '#D85A30', polygon: '#1D9E75' },
  { bbox: '#378ADD', polygon: '#D4537E' },
  { bbox: '#BA7517', polygon: '#7F77DD' },
  { bbox: '#5F5E5A', polygon: '#639922' },
  { bbox: '#993C1D', polygon: '#0C447C' },
]

export function defaultColorFor(category, allCategories) {
  const i = Math.max(0, allCategories.indexOf(category))
  return DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]
}

export async function getClassColors(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('class_colors')
    .eq('id', projectId)
    .single()
  if (error) throw error
  return data.class_colors ?? {}
}

export async function setClassColor(projectId, category, { bbox, polygon }) {
  const current = await getClassColors(projectId)
  const existing = current[category] ?? {}
  const next = {
    ...current,
    [category]: { bbox: bbox ?? existing.bbox, polygon: polygon ?? existing.polygon },
  }
  const { error } = await supabase
    .from('projects')
    .update({ class_colors: next })
    .eq('id', projectId)
  if (error) throw error
  return next
}