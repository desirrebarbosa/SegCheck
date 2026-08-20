import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readZipEntries } from '../lib/zipHelpers'
import { buildSingleSplitUploadPlan } from '../lib/manifest'
import { commitSplitPlan } from '../lib/uploads'
import { buildRedoUploadPlan, commitRedoUploadPlan } from '../lib/redoUpload'
import { rebalanceAllAssignments } from '../lib/projects'
import ProgressBar from '../components/ProgressBar'
import { useToast } from '../components/Toast'

export default function Upload() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [split, setSplit] = useState('')
  const [originalZip, setOriginalZip] = useState(null)
  const [samZip, setSamZip] = useState(null)
  const [planResult, setPlanResult] = useState(null) // { split, plan, unmatchedOriginalPhotos, orphanMasks, extraPhotosNotInOriginal }
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null) // null = hidden
  const [result, setResult] = useState(null)

  async function handleBuildPlan() {
    setResult(null)
    setBusy(true)
    try {
      if (!split.trim()) {
        throw new Error('Enter the split name for this upload (e.g. train, val, test).')
      }
      if (!originalZip || !samZip) {
        throw new Error('Pick both the original dataset zip and the SAM-assisted dataset zip.')
      }
      const [originalEntries, samEntries] = await Promise.all([
        readZipEntries(originalZip),
        readZipEntries(samZip),
      ])
      const built = await buildSingleSplitUploadPlan({ originalEntries, samEntries, split })
      setPlanResult(built)
    } catch (e) {
      showError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleCommit() {
    setBusy(true)
    setProgress(0)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const summary = await commitSplitPlan({
        projectId,
        split: planResult.split,
        userId: user.id,
        plan: planResult.plan,
        onProgress: (done, total) => setProgress(total ? done / total : 1),
      })
      // Everything this upload created is new, unassigned work — pending
      // masks to review, plus anything auto-failed to re-annotate. Split
      // both evenly across the current members so they route without a
      // manual step. Non-fatal: the upload itself already succeeded, so a
      // failure here shouldn't surface as a failed upload, and the next
      // upload (or member add) retries it.
      let assigned = 0
      let distributionFailed = false
      try {
        ;({ assigned } = await rebalanceAllAssignments(projectId))
      } catch (e) {
        console.error('rebalanceAllAssignments after upload failed:', e)
        distributionFailed = true
      }

      setResult({ split: planResult.split, ...summary, assigned, distributionFailed })
      setPlanResult(null)
      setSplit('')
      setOriginalZip(null)
      setSamZip(null)
      showSuccess('Upload committed.')
      // Reported separately from the upload result: the upload did succeed,
      // but the new work is sitting unassigned and needs a manual nudge.
      if (distributionFailed) {
        showError(
          'Uploaded, but could not distribute the new work — press “Distribute unassigned work” on the Members page.',
        )
      }
      // Hold at full for a beat so completion registers, then hide.
      setTimeout(() => setProgress(null), 400)
    } catch (e) {
      showError(e.message)
      // Bar stays frozen where it stopped — that's where it actually
      // failed, and snapping back to empty would misrepresent it.
    } finally {
      setBusy(false)
    }
  }

  const totalInstances = planResult?.plan.reduce((n, p) => n + p.instances.length, 0) ?? 0
  const missingInstances =
    planResult?.plan.reduce((n, p) => n + p.instances.filter((i) => i.missing).length, 0) ?? 0
  const missingWhole = planResult?.plan.filter((p) => p.missingWhole).length ?? 0

  return (
    <section className="max-w-2xl">
      <h2 className="text-lg font-medium">Upload</h2>
      <p className="mt-1 text-sm text-[#888780]">
        Upload one split at a time — each zip's root is already the split (images/ +
        annotations/coco.json, and masks/ + annotations/seg_coco.json), with no split subfolder
        inside. Original dataset is the source of truth; SAM-assisted provides the masks to
        review.
      </p>

      <div className="mt-5 space-y-2">
        <div className="flex items-center justify-between rounded-xl border border-[#B4B2A9] px-3.5 py-3 text-sm">
          <div>
            <p className="font-medium text-[#1a1a1a]">Split</p>
            <p className="text-xs text-[#888780]">e.g. train, val, test</p>
          </div>
          <input
            type="text"
            value={split}
            onChange={(e) => setSplit(e.target.value)}
            placeholder="split name"
            className="w-40 rounded-lg border border-[#B4B2A9] px-2.5 py-1.5 text-sm"
          />
        </div>
        <ZipPicker
          label="Original dataset"
          hint="images/ + annotations/coco.json"
          file={originalZip}
          onChange={setOriginalZip}
        />
        <ZipPicker
          label="SAM-assisted dataset"
          hint="masks/ + annotations/seg_coco.json"
          file={samZip}
          onChange={setSamZip}
        />
      </div>

      <button
        onClick={handleBuildPlan}
        disabled={busy}
        className="mt-4 rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Build plan'}
      </button>

      {planResult && (
        <div className="mt-5 rounded-xl border border-[#E5E4DF] overflow-hidden">
          <div className="border-b border-[#E5E4DF] px-3.5 py-2.5 text-xs font-medium text-[#1a1a1a]">
            {planResult.split} · {planResult.plan.length} photos
          </div>

          <div className="space-y-1.5 p-4 text-sm text-[#5F5E5A]">
            <p>
              {totalInstances} instances from the original dataset · {totalInstances - missingInstances}{' '}
              matched to a SAM mask
            </p>
            <p className="text-[#993C1D]">
              {missingInstances} auto-fail — never produced by the SAM-assisted pipeline
            </p>
            {missingWhole > 0 && (
              <p className="text-[#993C1D]">
                {missingWhole} photo(s) entirely absent from the SAM-assisted output
              </p>
            )}
            {planResult.extraPhotosNotInOriginal.length > 0 && (
              <p className="text-[#888780]">
                {planResult.extraPhotosNotInOriginal.length} photo(s) uploaded but not in the
                original dataset — skipped (out of scope)
              </p>
            )}
            {planResult.unmatchedOriginalPhotos.length > 0 && (
              <p className="text-[#888780]">
                {planResult.unmatchedOriginalPhotos.length} photo(s) in the original dataset were
                never uploaded — skipped
              </p>
            )}
          </div>

          <div className="space-y-3 border-t border-[#E5E4DF] p-4">
            <button
              onClick={handleCommit}
              disabled={busy}
              className="rounded-lg bg-[#639922] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Uploading…' : `Confirm & upload "${planResult.split}"`}
            </button>
            {progress !== null && (
              <ProgressBar percent={progress * 100} label="Uploading" />
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-1 text-sm text-[#27500A]">
          <p>
            Done — {result.photosCreated} new photos, {result.photosVersioned} re-uploaded,{' '}
            {result.masksCreated} masks created, {result.autoFailed} auto-failed, for split "
            {result.split}".
          </p>
          {result.distributionFailed && (
            <p className="text-[#791F1F]">
              Distribution failed — this upload&rsquo;s masks are unassigned. Press
              &ldquo;Distribute unassigned work&rdquo; on the Members page.
            </p>
          )}
          {result.assigned > 0 && (
            <p>{result.assigned} mask(s) distributed across the project's members to review.</p>
          )}
        </div>
      )}

      <RedoUpload projectId={projectId} />
    </section>
  )
}

// Second, independent flow: re-uploading corrected masks from a redo
// batch. Same build-a-plan-then-confirm shape as the original upload
// above, but a single zip and no split — the photos already exist.
function RedoUpload({ projectId }) {
  const { showError, showSuccess } = useToast()
  const [zip, setZip] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null) // null = hidden
  const [result, setResult] = useState(null)

  async function handleBuildPlan() {
    setResult(null)
    setBusy(true)
    try {
      if (!zip) throw new Error('Pick the edited redo zip first.')
      const entries = await readZipEntries(zip)
      const built = await buildRedoUploadPlan(entries, { projectId })
      if (built.matched.length === 0 && built.ignored.length === entries.length) {
        throw new Error(
          'No mask files found. Expected the redo batch layout: masks/<photo>/<id>-<name>.png',
        )
      }
      setPlan(built)
    } catch (e) {
      showError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleCommit() {
    setBusy(true)
    setProgress(0)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const summary = await commitRedoUploadPlan(plan, {
        userId: user.id,
        projectId,
        onProgress: (done, total) => setProgress(total ? done / total : 1),
      })
      // Back in the queue as pending and unassigned — hand them out again
      // so they land in someone's review stack rather than sitting loose.
      let distributionFailed = false
      try {
        await rebalanceAllAssignments(projectId)
      } catch (e) {
        console.error('rebalanceAllAssignments after redo upload failed:', e)
        distributionFailed = true
      }
      setResult(summary)
      setPlan(null)
      setZip(null)
      if (summary.failed.length > 0) {
        showError(`${summary.updated} uploaded, ${summary.failed.length} failed — see below.`)
      } else {
        showSuccess(`${summary.updated} redo mask(s) uploaded.`)
      }
      if (distributionFailed) {
        showError(
          'Uploaded, but could not return them to the review queue — press “Distribute unassigned work” on the Members page.',
        )
      }
      // Sit at full briefly so it doesn't look like it snapped away.
      setTimeout(() => setProgress(null), 400)
    } catch (e) {
      showError(e.message)
      // Freeze the bar where it stopped: that's where the failure actually
      // happened, and resetting to zero would misrepresent it.
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 max-w-2xl border-t border-[#E5E4DF] pt-8">
      <h2 className="text-lg font-medium">Upload redo images</h2>
      <p className="mt-1 text-sm text-[#888780]">
        Re-upload the corrected masks from a redo batch — the same zip Dashboard produced, with
        the mask images edited in place. Masks only; the photos already exist. Each mask is
        clipped to its bounding box and its outline re-encoded, then goes back into the review
        queue.
      </p>

      <div className="mt-5">
        <ZipPicker
          label="Edited redo zip"
          hint="masks/<photo>/<id>-<name>.png"
          file={zip}
          onChange={setZip}
        />
      </div>

      <button
        onClick={handleBuildPlan}
        disabled={busy}
        className="mt-4 rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy && !plan ? 'Working…' : 'Check zip'}
      </button>

      {plan && (
        <div className="mt-5 overflow-hidden rounded-xl border border-[#E5E4DF]">
          <div className="border-b border-[#E5E4DF] px-3.5 py-2.5 text-xs font-medium text-[#1a1a1a]">
            {plan.matched.length} mask(s) ready to upload
          </div>

          <div className="space-y-1.5 p-4 text-sm text-[#5F5E5A]">
            <p>{plan.matched.length} matched a failed mask and will be replaced</p>
            {plan.wrongStatus.length > 0 && (
              <p className="text-[#993C1D]">
                {plan.wrongStatus.length} skipped — no longer marked fail (already reviewed)
              </p>
            )}
            {plan.unmatched.length > 0 && (
              <p className="text-[#993C1D]">
                {plan.unmatched.length} skipped — no mask in this project with that id
              </p>
            )}
            {plan.duplicates.length > 0 && (
              <p className="text-[#993C1D]">
                {plan.duplicates.length} skipped — duplicate id, two files claim the same mask
              </p>
            )}
            {plan.ignored.length > 0 && (
              <p className="text-[#888780]">
                {plan.ignored.length} other file(s) ignored (photos, instructions.csv, unnamed
                masks)
              </p>
            )}
          </div>

          <div className="space-y-3 border-t border-[#E5E4DF] p-4">
            <button
              onClick={handleCommit}
              disabled={busy || plan.matched.length === 0}
              className="rounded-lg bg-[#639922] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Uploading…' : `Confirm & upload ${plan.matched.length} mask(s)`}
            </button>
            {progress !== null && (
              <ProgressBar percent={progress * 100} label="Uploading" />
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-1 text-sm">
          <p className="text-[#27500A]">
            Done — {result.updated} mask(s) re-uploaded and returned to the review queue.
          </p>
          {result.failed.length > 0 && (
            <div className="text-[#791F1F]">
              <p>{result.failed.length} failed:</p>
              <ul className="ml-4 list-disc">
                {result.failed.map((f) => (
                  <li key={f.annotationId}>
                    {f.annotationId} — {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ZipPicker({ label, hint, file, onChange }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[#B4B2A9] px-3.5 py-3 text-sm">
      <div>
        <p className="font-medium text-[#1a1a1a]">{label}</p>
        <p className="text-xs text-[#888780]">{hint}</p>
      </div>
      <span className="flex items-center gap-2">
        {file && <span className="text-xs text-[#888780]">{file.name}</span>}
        <input
          type="file"
          accept=".zip"
          className="text-xs"
          onChange={(e) => onChange(e.target.files[0] ?? null)}
        />
      </span>
    </div>
  )
}