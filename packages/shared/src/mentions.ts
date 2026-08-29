/**
 * Extract @mentions from message content. Mentions are matched against known
 * member names, longest-first, case-insensitive, so "@Scout Bot" wins over
 * "@Scout" when both exist.
 */
export function extractMentions(content: string, knownNames: string[]): string[] {
  const sorted = [...knownNames].sort((x, y) => y.length - x.length)
  const found: string[] = []
  const lower = content.toLowerCase()
  for (const name of sorted) {
    const needle = `@${name.toLowerCase()}`
    let idx = lower.indexOf(needle)
    while (idx !== -1) {
      const after = lower[idx + needle.length]
      const isBoundary = after === undefined || !/[a-z0-9_]/.test(after)
      if (isBoundary && !found.includes(name)) {
        found.push(name)
      }
      idx = lower.indexOf(needle, idx + 1)
    }
  }
  return found
}
