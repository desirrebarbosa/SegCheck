import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readZipEntries } from '../lib/zipHelpers'
import { classifyZipEntries, buildUploadPlan } from '../lib/manifest'
import { commitUploadPlan } from '../lib/uploads'
import { useToast } from '../components/Toast'

// NOTE: this is a visual reskin only. The underlying logic is still the
// original single-zip flow (images/ + masks/ + annotations/seg_coco.json in
// one zip). The dual-zip (original dataset as source of truth + SAM-assisted
// masks, cross-checked) and multi-split rework are planned but not yet
// implemented — see PLAN.md.
export default function Upload() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [zipFile, setZipFile] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  async function handleBuildPlan() {
    setResult(null)
    setBusy(true)
    try {
      if (!zipFile) throw new Error('Pick a dataset zip first.')

      const entries = await readZipEntries(zipFile)
      const { photoFiles, maskFiles, manifestJson } = await classifyZipEntries(entries)

      if (photoFiles.length === 0) throw new Error('No files found under an images/ folder.')
      if (maskFiles.length === 0) throw new Error('No files found under a masks/ folder.')

      setPlan(buildUploadPlan({ photoFiles, maskFiles, manifestJson }))
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
      const summary = await commitUploadPlan({ projectId, userId: user.id, plan: plan.plan })
      setResult(summary)
      setPlan(null)
      setZipFile(null)
      showSuccess('Upload committed.')
    } catch (e) {
      showError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const totalInstances = plan?.plan.reduce((n, p) => n + p.instances.length, 0) ?? 0
  const totalMissingInstances =
    plan?.plan.reduce((n, p) => n + p.instances.filter((i) => i.missing).length, 0) ?? 0
  const totalMissingWhole = plan?.plan.filter((p) => p.missingWhole).length ?? 0

  return (
    <section className="max-w-2xl">
      <h2 className="text-lg font-medium">Upload</h2>
      <p className="mt-1 text-sm text-[#888780]">
        One zip containing <code className="text-[#5F5E5A]">images/</code>,{' '}
        <code className="text-[#5F5E5A]">masks/</code>, and{' '}
        <code className="text-[#5F5E5A]">annotations/seg_coco.json</code>. Re-uploading a photo
        that already exists creates a new version — only the new masks go back into review.
      </p>

      <label className="mt-5 flex items-center justify-between rounded-xl border border-[#B4B2A9] px-3.5 py-3 text-sm">
        <span className="flex items-center gap-2 text-[#1a1a1a]">
          <i className="ti ti-file-zip text-base text-[#888780]" aria-hidden="true"></i>
          Dataset .zip
        </span>
        <span className="flex items-center gap-2">
          {zipFile && <span className="text-xs text-[#888780]">{zipFile.name}</span>}
          <input
            type="file"
            accept=".zip"
            className="text-xs"
            onChange={(e) => setZipFile(e.target.files[0] ?? null)}
          />
        </span>
      </label>

      <button
        onClick={handleBuildPlan}
        disabled={busy}
        className="mt-4 rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Build plan'}
      </button>

      {plan && (
        <div className="mt-5 space-y-1.5 rounded-xl border border-[#E5E4DF] bg-[#F7F7F5] p-4 text-sm">
          <p>
            {plan.plan.length} photos · {totalInstances} instances ({totalMissingInstances}{' '}
            auto-fail — no matching mask file)
          </p>
          <p>{totalMissingWhole} photo(s) not in the manifest at all — auto-failed whole</p>
          {plan.unmatchedManifestPhotos.length > 0 && (
            <p className="text-[#993C1D]">
              {plan.unmatchedManifestPhotos.length} manifest photo(s) never uploaded, skipped:{' '}
              {plan.unmatchedManifestPhotos.map((p) => p.fileName).join(', ')}
            </p>
          )}
          {plan.orphanMasks.length > 0 && (
            <p className="text-[#993C1D]">
              {plan.orphanMasks.length} mask file(s) matched no annotation, ignored:{' '}
              {plan.orphanMasks.map((m) => m.name).join(', ')}
            </p>
          )}

          <button
            onClick={handleCommit}
            disabled={busy}
            className="mt-2 rounded-lg bg-[#639922] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Uploading…' : 'Confirm & upload'}
          </button>
        </div>
      )}

      {result && (
        <p className="mt-4 text-sm text-[#27500A]">
          Done — {result.photosCreated} new photos, {result.photosVersioned} re-uploaded (new
          version), {result.masksCreated} masks created, {result.autoFailed} auto-failed.
        </p>
      )}
    </section>
  )
}