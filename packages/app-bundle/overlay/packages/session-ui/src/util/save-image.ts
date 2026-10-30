// Image download that lands on the machine the user is sitting at. Inside the
// Amicode chat iframe an <a download> goes nowhere useful (the webview has no
// download manager), so the PNG rides the existing "save-file" bridge envelope:
// the extension host opens a native Save dialog (defaulting to ~/Downloads) and
// writes the bytes there. Unframed (desktop shell, plain browser), a normal
// anchor download stands. The bridge accepts PNG only, so every source is
// rasterized first, the same as image copy.
import { pngDataUrl } from "./clipboard"

export async function saveImage(src: string, filename: string): Promise<boolean> {
  const png = await pngDataUrl(src)
  if (!png) return false
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ source: "amicode", kind: "save-file", filename, dataUrl: png }, "*")
    return true // fire-and-forget: the host owns the dialog and the outcome
  }
  if (typeof document === "undefined") return false
  const link = document.createElement("a")
  link.href = png
  link.download = filename
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
  return true
}
