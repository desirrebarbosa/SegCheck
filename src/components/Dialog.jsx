import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const DialogContext = createContext(null)

// In-app replacements for window.confirm() and window.prompt().
//
// Same shape as ToastProvider: one provider at the app root, one hook, and a
// thrown error if the hook is used outside it.
//
// The call sites are what drove the API. Every one of them already looked
// like `if (!confirm(...)) return`, inside an async function — so confirm()
// here returns a PROMISE resolved by whichever button is pressed, and the
// only change a call site needs is an `await`. promptText() likewise returns
// null on cancel, so existing `if (next === null) return` guards still work.
export function DialogProvider({ children }) {
  // null = nothing open.
  const [request, setRequest] = useState(null)

  // The caller's `resolve` lives in a ref, not in state: settling is a side
  // effect, and doing it inside a state updater would make the updater impure
  // and fire twice under StrictMode.
  const resolveRef = useRef(null)

  const open = useCallback(
    (spec) =>
      new Promise((resolve) => {
        resolveRef.current = resolve
        // A fresh id per request so DialogPanel remounts — without it React
        // reuses the instance and the second prompt opens holding the first
        // one's text.
        setRequest({ ...spec, id: Math.random().toString(36).slice(2) })
      }),
    [],
  )

  const confirm = useCallback((options) => open({ ...options, kind: 'confirm' }), [open])
  const promptText = useCallback((options) => open({ ...options, kind: 'prompt' }), [open])

  const settle = useCallback((value) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setRequest(null)
    resolve?.(value)
  }, [])

  const value = useMemo(() => ({ confirm, promptText }), [confirm, promptText])

  return (
    <DialogContext.Provider value={value}>
      {children}
      {request && <DialogPanel key={request.id} request={request} onSettle={settle} />}
    </DialogContext.Provider>
  )
}

function DialogPanel({ request, onSettle }) {
  const { kind, title, message, confirmLabel, tone, label, placeholder, allowEmpty } = request
  const [text, setText] = useState(request.defaultValue ?? '')
  const inputRef = useRef(null)
  const confirmRef = useRef(null)

  const cancelValue = kind === 'prompt' ? null : false

  // Focus the thing you are most likely to act on, and put focus back where
  // it was on close — without this a keyboard user is dumped at the top of
  // the document after every delete.
  useEffect(() => {
    const previous = document.activeElement
    if (kind === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      confirmRef.current?.focus()
    }
    return () => previous?.focus?.()
  }, [kind])

  // Stop the page behind from scrolling while the dialog is up.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // Escape cancels from anywhere, not just when a button has focus.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onSettle(cancelValue)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onSettle, cancelValue])

  const trimmed = text.trim()
  const submitDisabled = kind === 'prompt' && !allowEmpty && !trimmed

  function submit(e) {
    e?.preventDefault()
    if (submitDisabled) return
    onSettle(kind === 'prompt' ? text : true)
  }

  return (
    <div
      // Clicking the backdrop cancels; the panel below stops propagation, so
      // a click that starts inside the panel never reaches this.
      onClick={() => onSettle(cancelValue)}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1a1a]/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[#E5E4DF] bg-white p-5 shadow-lg"
      >
        <h2 id="dialog-title" className="text-base font-medium text-[#1a1a1a]">
          {title}
        </h2>
        {message && <p className="mt-2 text-sm text-[#888780]">{message}</p>}

        <form onSubmit={submit}>
          {kind === 'prompt' && (
            <label className="mt-4 block">
              {label && <span className="text-sm text-[#5F5E5A]">{label}</span>}
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={placeholder}
                className="mt-1 w-full rounded-lg border border-[#B4B2A9] px-3 py-2 text-sm"
              />
            </label>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onSettle(cancelValue)}
              className="rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="submit"
              disabled={submitDisabled}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                tone === 'danger' ? 'bg-[#791F1F]' : 'bg-[#1a1a1a]'
              }`}
            >
              {confirmLabel ?? (kind === 'prompt' ? 'Save' : 'Confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog must be used within a DialogProvider')
  return ctx
}
