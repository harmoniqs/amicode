// AMICODE: institution name/logo lookup — shared by the About-You card and the
// onboarding wizard. Pipeline (client-side by design, all CORS-open):
//   1. Clearbit autocomplete → name + domain (its logo CDN is sunset; only the
//      suggest API lives on)
//   2. Wikidata P154 "logo image" → Commons FilePath @512px (crisp BRAND mark —
//      the NYU torch, not the seal)
//   3. Wikipedia pageimage original (when P154 is absent)
//   4. Google faviconV2 @256 (instant placeholder + last resort)
// Pure async functions — callers own debounce/sequencing/signals.

export type InstitutionSuggestion = { name: string; domain: string; logo: string }

/** Instant favicon mark for a domain (placeholder + last-resort logo). */
export function institutionLogoUrl(domain: string): string {
  return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${encodeURIComponent(domain)}&size=256`
}

/** Clearbit autocomplete: name + domain suggestions (top 5). Never rejects. */
export async function suggestInstitutions(query: string): Promise<InstitutionSuggestion[]> {
  const q = query.trim()
  if (q.length < 2) return []
  try {
    const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`)
    const rows = r.ok ? await r.json() : []
    return Array.isArray(rows) ? rows.slice(0, 5) : []
  } catch {
    return []
  }
}

const wikiJson = (url: string) =>
  fetch(url)
    .then((r) => (r.ok ? r.json() : undefined))
    .catch(() => undefined)

/** Best brand logo for an institution: Wikidata P154 → Wikipedia pageimage →
 *  favicon. Never rejects; always returns SOME url. */
export async function resolveBrandLogo(name: string, domain: string): Promise<string> {
  const found = await wikiJson(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&origin=*`,
  )
  const qid = found?.search?.[0]?.id
  if (qid) {
    const claims = await wikiJson(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P154&format=json&origin=*`,
    )
    const file = claims?.claims?.P154?.[0]?.mainsnak?.datavalue?.value
    if (typeof file === "string" && file) {
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=512`
    }
  }
  const page = await wikiJson(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&titles=${encodeURIComponent(name)}&prop=pageimages&piprop=original`,
  )
  const orig = (Object.values(page?.query?.pages ?? {})[0] as any)?.original?.source
  if (typeof orig === "string" && /\.(svg|png|jpe?g|webp)$/i.test(orig)) return orig
  return institutionLogoUrl(domain)
}
