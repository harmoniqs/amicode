export const reorderPreviewTabs = (paths: readonly string[], path: string, toIndex: number): string[] => {
  const next = [...paths]
  const fromIndex = next.indexOf(path)
  if (fromIndex === -1) return next

  const target = Math.max(0, Math.min(toIndex, next.length - 1))
  if (fromIndex === target) return next

  next.splice(target, 0, next.splice(fromIndex, 1)[0])
  return next
}
