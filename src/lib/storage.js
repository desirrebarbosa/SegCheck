import { supabase } from './supabaseClient'

const BUCKET = 'segcheck'

export async function uploadFile(path, fileOrBlob) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, fileOrBlob, { upsert: true, contentType: fileOrBlob.type || undefined })
  if (error) throw error
  return path
}

export async function getSignedUrl(path, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresIn)
  if (error) throw error
  return data.signedUrl
}

// Fetches the raw file back as a Blob (used for building the redo zip).
// `signal`, if given, cancels the in-flight network request — not just a
// local no-op, an actually-aborted fetch — so cancelling a batch export
// stops burning bandwidth on downloads nobody's waiting for anymore.
export async function downloadBlob(path, { signal } = {}) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path, {}, { signal })
  if (error) throw error
  return data
}