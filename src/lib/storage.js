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
export async function downloadBlob(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error) throw error
  return data
}