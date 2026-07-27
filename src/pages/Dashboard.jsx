import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readZipEntries } from '../lib/zipHelpers'
import { buildUploadPlan } from '../lib/manifest'
import { commitUploadPlan } from '../lib/uploads'

export default function Upload() {
  const { projectId } = useOutletContext()
  const [photoZip, setPhotoZip] = useState(null)
  const [maskZip, setMaskZip] = useState(null)
  const [manifestFile, setManifestFile] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  async function handleBuildPlan() {
    setError(null)
    setResult(null)
    setBusy(true)
    try {
      if (!photoZip || !maskZip || !manifestFile) {
        throw new Error('Pick a photos zip, a masks zip, and the manifest JSON.')
      }
      const [photoEntries, maskEntries, manifestText] = await Promise.all([
        readZipEntries(photoZip),
        readZipEntries(maskZip),
        manifestFile.text(),
      ])
      const manifestJson = JSON.parse(manifestText)
      const photoFiles = photoEntries.map((e) => ({ ...e, file: e.blob }))
      const maskFiles = maskEntries.map((e) => ({ ...e, file: e.blob }))
      setPlan(buildUploadPlan({ photoFiles, maskFiles, manifestJson }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleCommit() {
    setBusy(true)
    setError(null)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const summary = await commitUploadPlan({ projectId, userId: user.id, plan: plan.plan })
      setResult(summary)
      setPlan(null)
      setPhotoZip(null)
      setMaskZip(null)
      setManifestFile(null)
    } catch (e) {
      setError(e.message)
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
      <h2 className="text-xl font-semibold">Upload</h2>
      <p className="mt-1 text-sm text-slate-500">
        Upload a photos zip, a masks zip, and the manifest (COCO-style instance JSON: images[],
        annotations[], categories[]). Re-uploading a photo that already exists in this project
        creates a new version — only the new masks go back into the review queue.
      </p>

      <div className="mt-6 space-y-3">
        <FilePicker label="Photos .zip" accept=".zip" file={photoZip} onChange={setPhotoZip} />
        <FilePicker label="Masks .zip" accept=".zip" file={maskZip} onChange={setMaskZip} />
        <FilePicker
          label="Manifest .json"
          accept=".json,application/json"
          file={manifestFile}
          onChange={setManifestFile}
        />
      </div>

      <button
        onClick={handleBuildPlan}
        disabled={busy}
        className="mt-4 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Build plan'}
      </button>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {plan && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm space-y-1">
          <p>
            {plan.plan.length} photos · {totalInstances} instances ({totalMissingInstances}{' '}
            auto-fail — no matching mask file)
          </p>
          <p>{totalMissingWhole} photo(s) not in the manifest at all — auto-failed whole</p>
          {plan.unmatchedManifestPhotos.length > 0 && (
            <p className="text-amber-600">
              {plan.unmatchedManifestPhotos.length} manifest photo(s) never uploaded, skipped:{' '}
              {plan.unmatchedManifestPhotos.map((p) => p.fileName).join(', ')}
            </p>
          )}
          {plan.orphanMasks.length > 0 && (
            <p className="text-amber-600">
              {plan.orphanMasks.length} mask file(s) matched no annotation, ignored:{' '}
              {plan.orphanMasks.map((m) => m.name).join(', ')}
            </p>
          )}

          <button
            onClick={handleCommit}
            disabled={busy}
            className="mt-3 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Uploading…' : 'Confirm & upload'}
          </button>
        </div>
      )}

      {result && (
        <p className="mt-4 text-sm text-emerald-700">
          Done — {result.photosCreated} new photos, {result.photosVersioned} re-uploaded (new
          version), {result.masksCreated} masks created, {result.autoFailed} auto-failed.
        </p>
      )}
    </section>
  )
}

function FilePicker({ label, accept, file, onChange }) {
  return (
    <label className="flex items-center justify-between rounded border border-slate-300 px-3 py-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="flex items-center gap-2">
        {file && <span className="text-xs text-slate-400">{file.name}</span>}
        <input
          type="file"
          accept={accept}
          className="text-xs"
          onChange={(e) => onChange(e.target.files[0] ?? null)}
        />
      </span>
    </label>
  )
}