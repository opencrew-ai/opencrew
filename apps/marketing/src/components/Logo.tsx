interface LogoProps {
  className?: string
}

/** OpenCrew brand mark — crew nodes flanked by terminal brackets on a dark tile. */
export function Logo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label="OpenCrew" className={className}>
      <rect width="64" height="64" rx="14" fill="#0F1412" />
      <g
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 17 L16.5 17 L16.5 47 L22 47" />
        <path d="M42 17 L47.5 17 L47.5 47 L42 47" />
      </g>
      <g stroke="#FFFFFF" strokeWidth="1.6" strokeOpacity="0.6" strokeLinecap="round">
        <line x1="29.03" y1="29.03" x2="24.48" y2="24.48" />
        <line x1="34.97" y1="29.03" x2="39.52" y2="24.48" />
        <line x1="29.03" y1="34.97" x2="24.48" y2="39.52" />
        <line x1="34.97" y1="34.97" x2="39.52" y2="39.52" />
      </g>
      <g fill="#FFFFFF">
        <circle cx="22.5" cy="22.5" r="2.8" />
        <circle cx="41.5" cy="22.5" r="2.8" />
        <circle cx="22.5" cy="41.5" r="2.8" />
        <circle cx="41.5" cy="41.5" r="2.8" />
      </g>
      <circle cx="32" cy="32" r="4.2" fill="#FFFFFF" />
    </svg>
  )
}
