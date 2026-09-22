// #1414: pure page-clamp for PDF scroll/position restore, extracted so the
// containment decision is unit-tested away from the pdf.js / DOM wiring in
// pdf-canvas-view.tsx.

/**
 * Clamp a restore target page into the valid range for a loaded document.
 * Pages are 1-based. When the page count is not yet known (0), the target is
 * preserved (floored to 1) — there is nothing to clamp against yet; once the
 * document loads with `pageCount > 0` the target is clamped to the last page so
 * a regenerated, shorter PDF can still complete its restore.
 */
export function clampRestorePage(page: number, pageCount: number): number {
  const atLeastOne = Math.max(1, Math.floor(page))
  if (!Number.isFinite(pageCount) || pageCount <= 0) return atLeastOne
  return Math.min(atLeastOne, pageCount)
}
