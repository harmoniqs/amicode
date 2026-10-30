// AMICODE: full-size preview for a chat image, with download and copy. The
// stock ImagePreview (ui) is close-only; agent-produced figures (equations,
// plots) are usually opened to be copied or saved into a deck or doc, so the
// header carries download + copy next to close. Same data-component as
// ImagePreview so it rides the shared image-preview styles.
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createSignal, onCleanup } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { copyImageToClipboard } from "../util/clipboard"
import { saveImage } from "../util/save-image"

export function ImageLightbox(props: { src: string; alt?: string; filename?: string }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  // The host's native write can fail (copyImageToClipboard awaits its nonce'd
  // reply) — a failure is reported on the button, never shown as "Copied".
  const [failed, setFailed] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = async () => {
    const ok = await copyImageToClipboard(props.src)
    setCopied(ok)
    setFailed(!ok)
    clearTimeout(timer)
    timer = setTimeout(() => {
      setCopied(false)
      setFailed(false)
    }, 2000)
  }
  const label = () => (copied() ? i18n.t("ui.message.copied") : failed() ? "Copy failed" : i18n.t("ui.message.copy"))
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <IconButton
              data-slot="image-preview-download"
              icon="download"
              variant="ghost"
              aria-label={i18n.t("ui.message.download")}
              title={i18n.t("ui.message.download")}
              onClick={() => void saveImage(props.src, props.filename ?? "image.png")}
            />
            <IconButton
              data-slot="image-preview-copy"
              icon={copied() ? "check-small" : "copy"}
              variant="ghost"
              data-copy-failed={failed() ? "true" : undefined}
              aria-label={label()}
              title={label()}
              onClick={() => void copy()}
            />
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body">
            <img src={props.src} alt={props.alt || i18n.t("ui.imagePreview.alt")} data-slot="image-preview-image" />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
