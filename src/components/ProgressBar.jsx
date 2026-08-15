// A small determinate progress bar for long-running client-side exports
// (fetching photos/masks from Storage, rendering instance previews,
// compressing the zip) — so a multi-second wait shows real movement
// instead of a static "Working…" label that reads as a hang.
//
// `onCancel`, if given, renders a Cancel affordance next to the label —
// opt-in so callers that can't actually cancel (or don't wire it up yet)
// don't show a button that does nothing.
export default function ProgressBar({ percent, label, onCancel }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className="mt-2 w-full max-w-sm">
      <div className="flex items-center justify-between text-xs text-[#888780]">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {Math.round(clamped)}%
          {onCancel && (
            <button
              onClick={onCancel}
              className="font-medium text-[#993C1D] hover:underline"
              type="button"
            >
              Cancel
            </button>
          )}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#F1EFE8]">
        <div
          className="h-full rounded-full bg-[#D85A30] transition-[width] duration-150"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
