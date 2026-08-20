// Client for SegCheck's Python side — a separate FastAPI service in its
// own repo (SegCheck-api), called directly from the browser. Configured
// via VITE_GUIDE_API_URL; everything here fails gracefully with a clear
// message rather than a crash when that's unset, since the service is
// deployed separately and may not exist in a given environment.
//
// Generalized from the original guide-only client: `post()` owns the base
// URL, headers and error parsing, and `fetchGuide()` is one endpoint built
// on top of it. A second endpoint (a server-side mask clip, say) reuses
// the same base rather than duplicating the fetch wrapper.
//
// CONTRACT (implemented in the SegCheck-api repo):
//   POST {VITE_GUIDE_API_URL}/guide
//   Request:
//     {
//       mask_url: string | null,   // signed URL to the failed mask PNG,
//                                  // null when no mask was ever produced
//       photo_url: string,         // signed URL to the original photo
//       bbox: [x, y, w, h],
//       category: string,
//       guide_type: "skeleton" | "star_convex" | null
//                                  // explicit override; null = the API
//                                  // decides from the mask's shape
//     }
//   Response:
//     {
//       guide_type: "skeleton" | "star_convex" | "bbox_only",
//       image_url: string          // data: URI of the rendered guide
//     }
//
// `bbox_only` is returned rather than an error when mask_url is null:
// there's no shape to derive a guide from, but the bbox alone is still a
// useful starting point for the annotator.
//
// Nothing here writes to Supabase — it only fetches a guide for display.

const API_URL = import.meta.env.VITE_GUIDE_API_URL

export function isGuideApiConfigured() {
  return !!API_URL
}

// Shared POST: base URL, JSON encoding, and error parsing in one place.
// FastAPI reports failures as {"detail": ...}, so surface that when it's
// present instead of a bare status code — a validation error naming the
// offending field is far more useful than "422".
export async function post(path, body) {
  if (!API_URL) {
    throw new Error('Guide service isn’t connected yet (VITE_GUIDE_API_URL is unset).')
  }

  let res
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // A network-level failure (service down, DNS, CORS preflight refused)
    // rejects before any response exists, so there's no status to report.
    throw new Error('Could not reach the guide service — it may be offline.')
  }

  if (!res.ok) {
    let detail = null
    try {
      detail = (await res.json())?.detail
    } catch {
      // Non-JSON error body (a proxy's HTML 502 page, say) — ignore it and
      // fall back to the status code below.
    }
    throw new Error(
      detail
        ? `Guide service error: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
        : `Guide service returned an error (${res.status}).`,
    )
  }

  return res.json()
}

// Fetches a re-annotation guide for one failed mask.
//
// `guideType` is optional: pass 'skeleton' or 'star_convex' to force one
// (for a per-category default, once that UI exists), or leave it out and
// the API picks based on the mask's own geometry.
export async function fetchGuide({ maskUrl, photoUrl, bbox, category, guideType = null }) {
  return post('/guide', {
    mask_url: maskUrl ?? null,
    photo_url: photoUrl,
    bbox,
    category,
    guide_type: guideType,
  })
}
