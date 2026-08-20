// A filling bar with no numeric label, driven by real work completed.
//
// No "3 of 12" and no percentage text, deliberately: the underlying work
// finishes in bounded-concurrent batches, so counts arrive in clusters and
// a visible number would jitter in a way a bar simply doesn't.
//
// The width transition exists for the same reason — a batch of ~6 photos
// completing together would otherwise look like the bar stalls and then
// jumps. Easing across the gap reads as steady progress.
//
// `value` is a fraction from 0 to 1 and is clamped, so callers can pass
// done/total without guarding against total === 0.
export default function ProgressBar({ value = 0, tone = 'dark' }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100
  const fill = tone === 'danger' ? 'bg-[#791F1F]' : tone === 'success' ? 'bg-[#639922]' : 'bg-[#1a1a1a]'

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-[#E5E4DF]"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ease-out ${fill}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
