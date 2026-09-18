import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspace } from '../lib/workspace'

interface PaywallDetail {
  error?: string
  upgradeUrl?: string
  used?: number
  limit?: number
}

/**
 * The paywall, shown exactly when it is felt: a decision made from the
 * phone (through opencrew.run) past the free three this month. Everything on
 * the laptop stays free; this sells only the part the laptop cannot do.
 */
export function PaywallModal() {
  const { attention } = useWorkspace()
  const [detail, setDetail] = useState<PaywallDetail | null>(null)

  useEffect(() => {
    const onPaywall = (event: Event) => setDetail((event as CustomEvent<PaywallDetail>).detail ?? {})
    window.addEventListener('opencrew:paywall', onPaywall)
    return () => window.removeEventListener('opencrew:paywall', onPaywall)
  }, [])

  if (!detail) return null
  const waiting = attention.length
  const upgradeUrl = detail.upgradeUrl ?? '/portal/pro'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Approve from your phone"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={() => setDetail(null)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">OpenCrew Pro</p>
        <h2 className="mt-2 text-xl font-bold text-zinc-100">Approve from your phone, without limits</h2>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          You&apos;ve used your {detail.limit ?? 3} free decisions from here this month.
          {waiting > 0 && (
            <>
              {' '}
              <span className="text-zinc-200">
                {waiting} item{waiting === 1 ? ' is' : 's are'} waiting on you
              </span>{' '}
              right now.
            </>
          )}{' '}
          Pro makes remote approvals unlimited. Everything on your laptop stays free.
        </p>
        <a
          href={upgradeUrl}
          className="mt-5 block rounded-lg bg-emerald-500 px-4 py-3 text-center text-sm font-bold text-zinc-950 transition hover:bg-emerald-400"
        >
          Unlock on your phone · $19/mo
        </a>
        <button
          onClick={() => setDetail(null)}
          className="mt-3 block w-full text-center text-xs text-zinc-500 hover:text-zinc-300"
        >
          Not now — I&apos;ll decide from my laptop
        </button>
      </div>
    </div>,
    document.body
  )
}
