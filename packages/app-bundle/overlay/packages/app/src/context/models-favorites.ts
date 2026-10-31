// amicode#1987 (#1979 S4): favorites over models.tsx's persisted `user[]`
// entries (the previously-unused `favorite` flag). PURE so the persistence
// rules are unit-tested; models.tsx applies the result with setStore.
// Ported from upstream TUI context/local.tsx toggleFavorite: newest favorite
// first; toggling off keeps the entry (it may carry a visibility choice).
export type ModelKey = { providerID: string; modelID: string }
export type Visibility = "show" | "hide"
/** `visibility` is optional: an entry created by favoriting carries no
 *  visibility choice (pre-#1987 persisted entries always have one). */
export type UserModelEntry = ModelKey & { visibility?: Visibility; favorite?: boolean }

const same = (a: ModelKey, b: ModelKey) => a.providerID === b.providerID && a.modelID === b.modelID

export function isFavorite(users: readonly UserModelEntry[], model: ModelKey) {
  return users.some((x) => same(x, model) && x.favorite === true)
}

export function favoritesOf(users: readonly UserModelEntry[]): ModelKey[] {
  return users.filter((x) => x.favorite === true).map((x) => ({ providerID: x.providerID, modelID: x.modelID }))
}

export function toggleFavorite(users: readonly UserModelEntry[], model: ModelKey): UserModelEntry[] {
  const existing = users.find((x) => same(x, model))
  if (existing?.favorite === true) return users.map((x) => (same(x, model) ? { ...x, favorite: false } : x))
  const entry: UserModelEntry = {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(existing?.visibility ? { visibility: existing.visibility } : {}),
    favorite: true,
  }
  return [entry, ...users.filter((x) => !same(x, model))]
}
