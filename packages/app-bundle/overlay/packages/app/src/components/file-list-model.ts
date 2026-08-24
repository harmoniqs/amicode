/**
 * Compute the longest shared directory prefix across a set of file paths.
 * Returns the deepest directory all paths share (not a partial segment match).
 */
export function getCommonAncestor(paths: string[]): string {
  if (paths.length === 0) return ""
  if (paths.length === 1) {
    const parts = paths[0].split("/")
    return parts.slice(0, -1).join("/")
  }

  const split = paths.map((p) => p.split("/").slice(0, -1))
  const minLen = Math.min(...split.map((s) => s.length))
  const common: string[] = []

  for (let i = 0; i < minLen; i++) {
    const segment = split[0][i]
    if (split.every((s) => s[i] === segment)) common.push(segment)
    else break
  }

  return common.join("/")
}

/**
 * Given a list of file paths, produce display labels with minimum disambiguation.
 * When two or more files share the same basename, append the minimum trailing
 * directory segments needed to distinguish them.
 */
export function disambiguateFilenames(paths: string[]): { path: string; label: string; disambiguator?: string }[] {
  const grouped = new Map<string, string[]>()
  for (const p of paths) {
    const name = p.split("/").pop() ?? ""
    const group = grouped.get(name) ?? []
    group.push(p)
    grouped.set(name, group)
  }

  return paths.map((p) => {
    const name = p.split("/").pop() ?? ""
    const group = grouped.get(name)!
    if (group.length === 1) return { path: p, label: name }

    const segments = p.split("/").slice(0, -1)
    const others = group.filter((o) => o !== p)

    for (let depth = 1; depth <= segments.length; depth++) {
      const candidate = segments.slice(segments.length - depth).join("/")
      const isUnique = others.every((o) => {
        const oSegments = o.split("/").slice(0, -1)
        const oCandidate = oSegments.slice(oSegments.length - depth).join("/")
        return oCandidate !== candidate
      })
      if (isUnique) return { path: p, label: name, disambiguator: candidate }
    }

    return { path: p, label: name, disambiguator: segments.join("/") }
  })
}

/**
 * Sort file paths alphabetically by their basename (case-insensitive).
 */
export function sortPathsByFilename(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const nameA = (a.split("/").pop() ?? "").toLowerCase()
    const nameB = (b.split("/").pop() ?? "").toLowerCase()
    return nameA.localeCompare(nameB)
  })
}
