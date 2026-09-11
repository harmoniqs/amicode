export function createPdfFixture(pageTexts: readonly string[]): string {
  const pageStreams = pageTexts.map((text) => `BT\n/F1 24 Tf\n72 720 Td\n(${text.replace(/[\\()]/g, "\\$&")}) Tj\nET\n`)
  const pageObjectStart = 3
  const fontObject = pageObjectStart + pageStreams.length
  const contentObjectStart = fontObject + 1
  const pageObjectIDs = pageStreams.map((_, index) => pageObjectStart + index)
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIDs.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`,
    ...pageStreams.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageStreams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}endstream`),
  ]
  const parts = ["%PDF-1.4\n"]
  const offsets = [0]

  for (const [index, object] of objects.entries()) {
    offsets.push(parts.join("").length)
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
  }

  const xrefOffset = parts.join("").length
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  for (const offset of offsets.slice(1)) {
    parts.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }
  parts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return Buffer.from(parts.join(""), "ascii").toString("base64")
}
