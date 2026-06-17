import { createClient } from '@supabase/supabase-js'

// These come from .env.local (Vite only exposes vars prefixed with VITE_).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase env vars. Copy .env.example to .env.local and fill them in.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)
