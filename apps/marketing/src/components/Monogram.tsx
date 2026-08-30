interface MonogramProps {
  name: string
  className?: string
}

/** Letter-tile avatar — quieter and more consistent than emoji faces. */
export function Monogram({ name, className = 'h-6 w-6 text-[11px]' }: MonogramProps) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-800/80 font-mono font-semibold uppercase text-zinc-300 ${className}`}
    >
      {name.trim().charAt(0)}
    </span>
  )
}
