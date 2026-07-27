// Bit 4 will fill this in: the queue of images/instances with auto-flag badges,
// instance-level confirm/override, whole-image reject, and category batch-confirm.
export default function ReviewQueue() {
  return (
    <section>
      <h2 className="text-xl font-semibold">Review Queue</h2>
      <p className="mt-2 text-sm text-slate-500">
        Coming in Bit 4 — instances to verify against their bounding boxes.
      </p>
    </section>
  )
}
