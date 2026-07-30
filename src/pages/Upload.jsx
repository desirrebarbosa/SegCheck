import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readZipEntries } from '../lib/zipHelpers'
import { buildMultiSplitUploadPlan } from '../lib/manifest'
import { commitMultiSplitPlan } from '../lib/uploads'
import { useToast } from '../components/Toast'

export default function Upload() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [originalZip, setOriginalZip] = useState(null)
  const [samZip, setSamZip] = useState(null)
  const [planResult, setPlanResult] = useState(null) // { bySplit, splitsOnlyInOriginal, splitsOnlyInSam }
  const [activeSplit, setActiveSplit] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  async function handleBuildPlan() {
    setResult(null)
    setBusy(true)
    try {
      if (!originalZip || !samZip) {
        throw new Error('Pick both the original dataset zip and the SAM-assisted dataset zip.')
      }
      const [originalEntries, samEntries] = await Promise.all([
        readZipEntries(originalZip),
        readZipEntries(samZip),
      ])
      const built = await buildMultiSplitUploadPlan({ originalEntries, samEntries })
      if (built.bySplit.size === 0) {
        throw new Error('No split was found in both zips — nothing to upload.')
      }
      setPlanResult(built)
      setActiveSplit([...built.bySplit.keys()][0])
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
      const summary = await commitMultiSplitPlan({
        projectId,
        userId: user.id,
        bySplit: planResult.bySplit,
      })
      setResult(summary)
      setPlanResult(null)
      setOriginalZip(null)
      setSamZip(null)
      showSuccess('Upload committed.')
    } catch (e) {
      showError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const active = activeSplit ? planResult?.bySplit.get(activeSplit) : null
  const totalInstances = active?.plan.reduce((n, p) => n + p.instances.length, 0) ?? 0
  const missingInstances =
    active?.plan.reduce((n, p) => n + p.instances.filter((i) => i.missing).length, 0) ?? 0
  const missingWhole = active?.plan.filter((p) => p.missingWhole).length ?? 0

  return (
    <section className="max-w-2xl">
      <h2 className="text-lg font-medium">Upload</h2>
      <p className="mt-1 text-sm text-[#888780]">
        Original dataset is the source of truth (images/ + annotations/coco.json). SAM-assisted
        provides the masks to review (masks/ + annotations/seg_coco.json). Both may contain
        multiple splits (test/train/val, or any names) — matched by split folder name.
      </p>

      <div className="mt-5 space-y-2">
        <ZipPicker
          label="Original dataset"
          hint="images/ + annotations/coco.json, per split"
          file={originalZip}
          onChange={setOriginalZip}
        />
        <ZipPicker
          label="SAM-assisted dataset"
          hint="masks/ + annotations/seg_coco.json, per split"
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
          <div className="flex border-b border-[#E5E4DF]">
            {[...planResult.bySplit.entries()].map(([split, r]) => (
              <button
                key={split}
                onClick={() => setActiveSplit(split)}
                className={`flex-1 px-3.5 py-2.5 text-xs font-medium ${
                  activeSplit === split
                    ? 'border-b-2 border-[#185FA5] text-[#1a1a1a]'
                    : 'text-[#888780]'
                }`}
              >
                {split} · {r.plan.length} photos
              </button>
            ))}
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
            {active?.extraPhotosNotInOriginal.length > 0 && (
              <p className="text-[#888780]">
                {active.extraPhotosNotInOriginal.length} photo(s) uploaded but not in the original
                dataset — skipped (out of scope)
              </p>
            )}
            {active?.unmatchedOriginalPhotos.length > 0 && (
              <p className="text-[#888780]">
                {active.unmatchedOriginalPhotos.length} photo(s) in the original dataset were
                never uploaded — skipped
              </p>
            )}
          </div>

          {(planResult.splitsOnlyInOriginal.length > 0 || planResult.splitsOnlyInSam.length > 0) && (
            <div className="border-t border-[#E5E4DF] bg-[#FCEBEB] p-3 text-xs text-[#791F1F]">
              {planResult.splitsOnlyInOriginal.length > 0 && (
                <p>
                  Only in original dataset (check split naming):{' '}
                  {planResult.splitsOnlyInOriginal.join(', ')}
                </p>
              )}
              {planResult.splitsOnlyInSam.length > 0 && (
                <p>
                  Only in SAM-assisted dataset (check split naming):{' '}
                  {planResult.splitsOnlyInSam.join(', ')}
                </p>
              )}
            </div>
          )}

          <div className="border-t border-[#E5E4DF] p-4">
            <button
              onClick={handleCommit}
              disabled={busy}
              className="rounded-lg bg-[#639922] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Uploading…' : `Confirm & upload all ${planResult.bySplit.size} split(s)`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-1 text-sm text-[#27500A]">
          <p>
            Done — {result.total.photosCreated} new photos, {result.total.photosVersioned}{' '}
            re-uploaded, {result.total.masksCreated} masks created, {result.total.autoFailed}{' '}
            auto-failed, across {Object.keys(result.perSplit).length} split(s).
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