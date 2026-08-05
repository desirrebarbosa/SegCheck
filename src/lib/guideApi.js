// Client for the Feature 6 "guided re-annotation" service — a separate
// Python API (your own repo, not this one). Configured via
// VITE_GUIDE_API_URL; every function here fails gracefully (clear error,
// not a crash) when that's unset, since the API doesn't exist yet.
//
// CONTRACT (implement this exactly in the Python API repo):
//   POST {VITE_GUIDE_API_URL}/guide
//   Request body (JSON):
//     {
//       mask_url: string,      // signed URL to the failed mask PNG
//       photo_url: string,     // signed URL to the original photo
//       bbox: [x, y, w, h],
//       category: string
//     }
//   Response body (JSON):
//     {
//       guide_type: "skeleton" | "star_convex",
//       image_url: string      // URL (or data: URI) of the rendered guide overlay
//     }
//   Non-2xx status -> treated as failure, surfaced to the UI.
//
// This mirrors the "plan before commit" pattern used elsewhere in the app:
// nothing here writes to Supabase — it only fetches a guide for display.

const GUIDE_API_URL = import.meta.env.VITE_GUIDE_API_URL

export function isGuideApiConfigured() {
  return !!GUIDE_API_URL
}

export async function fetchGuide({ maskUrl, photoUrl, bbox, category }) {
  if (!GUIDE_API_URL) {
    throw new Error('Guide service isn\u2019t connected yet (VITE_GUIDE_API_URL is unset).')
  }
  const res = await fetch(`${GUIDE_API_URL}/guide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mask_url: maskUrl, photo_url: photoUrl, bbox, category }),
  })
  if (!res.ok) {
    throw new Error(`Guide service returned an error (${res.status}).`)
  }
  return res.json() // { guide_type, image_url }
}