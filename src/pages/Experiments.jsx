import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import {
  archiveExperiment,
  deleteExperiment,
  listExperiments,
  listModelFamilies,
  setModelFamily,
} from '../lib/experiments'
import { TASK_LABELS } from '../lib/experimentImport'
import { useToast } from '../components/Toast'

// Column widths for the list. One string, used by both the header and the
// rows, so they cannot drift apart. Below md the grid collapses to one column
// and each cell prints its own label instead.
const GRID =
  'md:grid-cols-[3.5rem_minmax(0,1fr)_6.5rem_11rem_4.5rem_5rem_5rem_5rem_2.5rem]'

export default function Experiments() {
  const { projectId, isLead, isOwner } = useOutletContext()
  const { showError, showSuccess } = useToast()

  const [rows, setRows] = useState(null) // null = loading
  const [families, setFamilies] = useState([])
  const [query, setQuery] = useState('')
  const [pill, setPill] = useState('') // '' = All, else a reviewer id
  const [showArchived, setShowArchived] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [list, roster] = await Promise.all([
        listExperiments(projectId, { includeArchived: true }),
        listModelFamilies(projectId),
      ])
      setRows(list)
      setFamilies(roster)
    } catch (e) {
      console.error('Experiments refresh failed:', e)
      showError('Could not load experiments.')
    }
  }, [projectId, showError])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Close the row menu on any click that isn't inside it.
  useEffect(() => {
    if (!openMenuId) return
    const close = () => setOpenMenuId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenuId])

  const visible = useMemo(() => {
    if (!rows) return null
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (!showArchived && r.archived_at) return false
      if (pill && r.added_by !== pill) return false
      if (!q) return true
      return [r.title, r.backbone, r.neck, r.color_space, r.notes]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    })
  }, [rows, query, pill, showArchived])

  const archivedCount = rows?.filter((r) => r.archived_at).length ?? 0

  async function handleArchive(row) {
    const on = !row.archived_at
    if (
      on &&
      !confirm(
        `Archive ${row.title}?\n\n` +
          'It leaves the list but nothing is deleted — the run log, the chart and any ' +
          'attachments stay exactly as they are, and "Show archived" brings it back.',
      )
    )
      return
    try {
      await archiveExperiment(row.id, on)
      await refresh()
      showSuccess(on ? 'Experiment archived.' : 'Experiment restored.')
    } catch (e) {
      showError('Could not archive — ' + e.message)
    }
  }

  async function handleDelete(row) {
    if (
      !confirm(
        `Delete ${row.title}?\n\n` +
          'This removes the experiment, its whole run log and every attached file. ' +
          'It cannot be undone — archive it instead if you only want it out of the way.',
      )
    )
      return
    try {
      await deleteExperiment(row.id)
      await refresh()
      showSuccess('Experiment deleted.')
    } catch (e) {
      showError('Could not delete — ' + e.message)
    }
  }

  async function handleRename(reviewerId, current) {
    const next = prompt('Model family for this member (blank to clear):', current ?? '')
    if (next === null) return
    try {
      await setModelFamily(projectId, reviewerId, next)
      await refresh()
      showSuccess('Model family updated.')
    } catch (e) {
      showError(e.message)
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Experiments</h2>
          <p className="mt-1 text-sm text-[#888780]">
            One row per training run — architecture, final metrics and the per-epoch log the
            chart is drawn from. Import a JSON file to fill the form in one go.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <i
              className="ti ti-search pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-[#888780]"
              aria-hidden="true"
            ></i>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search experiments"
              className="w-48 rounded-lg border border-[#B4B2A9] py-2 pl-8 pr-3 text-sm"
            />
          </div>
          <Link
            to="new"
            aria-label="Add experiment"
            className="rounded-lg border border-[#B4B2A9] p-2 hover:bg-[#F7F7F5]"
          >
            <i className="ti ti-plus text-base" aria-hidden="true"></i>
          </Link>
        </div>
      </div>

      {/* One model family per member — picking a pill filters on who added it. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 overflow-x-auto rounded-full border border-[#E5E4DF] bg-white p-1 shadow-sm">
          <Pill active={pill === ''} onClick={() => setPill('')} label="All" />
          {families.map((f) => (
            <Pill
              key={f.reviewerId}
              active={pill === f.reviewerId}
              onClick={() => setPill(f.reviewerId)}
              label={f.label}
              onEdit={isLead ? () => handleRename(f.reviewerId, f.modelFamily) : null}
            />
          ))}
        </div>
        {archivedCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-[#5F5E5A]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived ({archivedCount})
          </label>
        )}
      </div>

      <div className="mt-5 divide-y divide-[#E5E4DF] rounded-xl border border-[#E5E4DF]">
        <div
          className={`hidden px-4 py-2 text-xs text-[#888780] md:grid ${GRID} md:items-center md:gap-3`}
        >
          <span>No.</span>
          <span>Title</span>
          <span>Date</span>
          <span>Task</span>
          <span>Epoch</span>
          <span>mAP.50</span>
          <span>mAP</span>
          <span>mIoU</span>
          <span className="sr-only">Actions</span>
        </div>

        {visible === null && <p className="p-4 text-sm text-[#888780]">Loading…</p>}
        {visible?.length === 0 && (
          <p className="p-4 text-sm text-[#888780]">
            {rows.length === 0
              ? 'No experiments yet — press + to add the first one.'
              : 'Nothing matches that search or filter.'}
          </p>
        )}

        {visible?.map((r) => (
          <div
            key={r.id}
            className={`grid grid-cols-1 gap-1 px-4 py-2.5 text-sm md:gap-3 ${GRID} md:items-center ${
              r.archived_at ? 'text-[#888780]' : ''
            }`}
          >
            <Cell label="No.">
              <span className="text-[#888780]">{String(r.seq).padStart(3, '0')}</span>
            </Cell>
            <Cell label="Title">
              <Link
                to={r.id}
                className="truncate font-medium text-[#1a1a1a] hover:underline"
                title={r.title}
              >
                {r.title}
              </Link>
              {r.archived_at && (
                <span className="ml-2 rounded-lg bg-[#F1EFE8] px-2 py-0.5 text-xs text-[#5F5E5A]">
                  archived
                </span>
              )}
            </Cell>
            <Cell label="Date">
              <span className="text-[#5F5E5A]">{r.run_date}</span>
            </Cell>
            <Cell label="Task">
              <span className="truncate text-[#5F5E5A]" title={r.tasks?.map(taskLabel).join(', ')}>
                {r.tasks?.map(taskLabel).join(', ')}
              </span>
            </Cell>
            <Cell label="Epoch">{num(r.epochs)}</Cell>
            <Cell label="mAP.50">{num(r.map_50)}</Cell>
            <Cell label="mAP">{num(r.map_avg)}</Cell>
            <Cell label="mIoU">{num(r.miou)}</Cell>

            <div className="relative flex justify-start md:justify-end">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenMenuId(openMenuId === r.id ? null : r.id)
                }}
                aria-label={`Actions for ${r.title}`}
                className="rounded-lg p-1 text-[#888780] hover:bg-[#F7F7F5] hover:text-[#1a1a1a]"
              >
                <i className="ti ti-dots-vertical text-base" aria-hidden="true"></i>
              </button>
              {openMenuId === r.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-8 z-10 w-40 overflow-hidden rounded-lg border border-[#E5E4DF] bg-white py-1 shadow-sm"
                >
                  <MenuLink to={r.id} icon="ti-eye" label="View" />
                  <MenuLink to={`${r.id}/edit`} icon="ti-pencil" label="Edit" />
                  <MenuItem
                    icon={r.archived_at ? 'ti-archive-off' : 'ti-archive'}
                    label={r.archived_at ? 'Restore' : 'Archive'}
                    onClick={() => {
                      setOpenMenuId(null)
                      handleArchive(r)
                    }}
                  />
                  {isOwner && (
                    <MenuItem
                      icon="ti-trash"
                      label="Delete"
                      danger
                      onClick={() => {
                        setOpenMenuId(null)
                        handleDelete(r)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────

function taskLabel(t) {
  return TASK_LABELS[t] ?? t
}

function num(v) {
  return v == null ? <span className="text-[#B4B2A9]">—</span> : String(v)
}

// On mobile the grid collapses to one column, so each value carries its own
// label; on md+ the header row provides them and this is hidden.
function Cell({ label, children }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-xs text-[#888780] md:hidden">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function Pill({ active, onClick, label, onEdit }) {
  return (
    <span className="flex flex-shrink-0 items-center">
      <button
        onClick={onClick}
        className={`rounded-full px-3 py-1 text-sm ${
          active ? 'bg-[#E6F1FB] text-[#0C447C]' : 'text-[#5F5E5A] hover:bg-[#F7F7F5]'
        }`}
      >
        {label}
      </button>
      {onEdit && (
        <button
          onClick={onEdit}
          aria-label={`Rename ${label}`}
          className="mr-1 rounded-full p-1 text-[#B4B2A9] hover:text-[#5F5E5A]"
        >
          <i className="ti ti-pencil text-xs" aria-hidden="true"></i>
        </button>
      )}
    </span>
  )
}

const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#F7F7F5]'

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button onClick={onClick} className={`${MENU_ITEM} ${danger ? 'text-[#791F1F]' : ''}`}>
      <i className={`ti ${icon} text-base`} aria-hidden="true"></i>
      {label}
    </button>
  )
}

function MenuLink({ to, icon, label }) {
  return (
    <Link to={to} className={MENU_ITEM}>
      <i className={`ti ${icon} text-base`} aria-hidden="true"></i>
      {label}
    </Link>
  )
}
