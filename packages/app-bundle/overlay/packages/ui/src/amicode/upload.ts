// AMICODE: browser File → base64 for the JSON upload routes (POST
// /amicode/library). Chunked conversion — String.fromCharCode(...whole-buffer)
// blows the arg-spread limit on multi-MB PDFs. Shared by the home Library
// card and the onboarding wizard's library step.

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ""
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  return btoa(bin)
}
