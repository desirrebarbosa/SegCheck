// Bit 3 will fill this in: two inputs (originals + SAM outputs), matched by
// filename stem, with re-upload bumping mask_version instead of duplicating.
export default function Upload() {
  return (
    <section>
      <h2 className="text-xl font-semibold">Upload</h2>
      <p className="mt-2 text-sm text-slate-500">
        Coming in Bit 3 — upload originals + SAM outputs (blocked on the two open
        questions: filename convention and bbox annotation format).
      </p>
    </section>
  )
}
