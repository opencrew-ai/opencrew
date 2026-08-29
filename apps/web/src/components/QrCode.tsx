import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** Small QR render for scan-me URLs. */
export function QrCode({ value, size = 148 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      color: { dark: '#0a0a0a', light: '#f4f4f5' }
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(null))
  }, [value, size])

  if (!dataUrl) return null
  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt={`QR code for ${value}`}
      className="rounded-lg border border-zinc-700"
    />
  )
}
