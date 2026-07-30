import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readZipEntries } from '../lib/zipHelpers'
import { buildSingleSplitUploadPlan } from '../lib/manifest'
import { commitSplitPlan } from '../lib/uploads'
import { useToast } from '../components/Toast'

export default function Upload() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [split, setSplit] = useState('')
  const [originalZip, setOriginalZip] = useState(null)
  const [samZip, setSamZip] = useState(null)
  const [planResult, setPlanResult] = useState(null) // { split, plan, unmatchedOriginalPhotos, orphanMasks, extraPhotosNotInOriginal }
  const [busy, setBusy] = useState(false)
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
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const summary = await commitSplitPlan({
        projectId,
        split: planResult.split,
        userId: user.id,
        plan: planResult.plan,
      })
      setResult({ split: planResult.split, ...summary })
      setPlanResult(null)
      setSplit('')
      setOriginalZip(null)
      setSamZip(null)
      showSuccess('Upload committed.')
    } catch (e) {
      showError(e.message)
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

          <div className="border-t border-[#E5E4DF] p-4">
            <button
              onClick={handleCommit}
              disabled={busy}
              className="rounded-lg bg-[#639922] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Uploading…' : `Confirm & upload "${planResult.split}"`}
            </button>
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