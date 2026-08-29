import type { VersionDiff } from '@opencrew/shared'

/** Side-by-side-ish diff: field changes as rows, prompt as a line diff. */
export function DiffView({ diff }: { diff: VersionDiff }) {
  const changedFields = diff.fields.filter((f) => f.kind !== 'same')
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h4 className="label">Config changes</h4>
        {changedFields.length === 0 ? (
          <p className="text-xs text-zinc-500">No config field changes.</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {changedFields.map((f) => (
                <tr key={f.field} className="border-b border-zinc-800/60">
                  <td className="py-1 pr-3 align-top font-mono text-zinc-400">{f.field}</td>
                  <td className="py-1 pr-3 align-top text-red-300 line-through">{f.oldValue}</td>
                  <td className="py-1 align-top text-emerald-300">{f.newValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <h4 className="label">System prompt</h4>
        {!diff.promptChanged ? (
          <p className="text-xs text-zinc-500">Prompt unchanged.</p>
        ) : (
          <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs leading-relaxed">
            {diff.promptDiff.map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === 'added'
                    ? 'bg-emerald-950/50 text-emerald-300'
                    : line.kind === 'removed'
                      ? 'bg-red-950/50 text-red-300'
                      : 'text-zinc-500'
                }
              >
                <span className="mr-2 select-none text-zinc-700">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                </span>
                {line.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}
