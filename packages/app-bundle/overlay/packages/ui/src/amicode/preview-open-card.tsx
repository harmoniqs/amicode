import { previewOpenMessage, type PreviewOpenRequest } from "./preview-open"

// AMICODE (#2130): the face of an amicode_open_preview tool part — a chip that
// reads "Preview <file>" and re-opens the file in this session's Preview when
// clicked. The AUTO-open on a live call is not here: this card only mounts once
// the sentinel exists (i.e. already completed), so the running → completed
// transition is watched by AmicodeToolCard (card.tsx), which is mounted from
// the part's first (pending) render. Same shell as AmicoSkillChip: a real
// <button type="button"> so it is keyboard-reachable and never submits the
// composer form.

export function openInPreview(path: string, sessionID: string | undefined): void {
  window.postMessage(previewOpenMessage(path, sessionID), "*")
}

export function PreviewOpenCard(props: { request: PreviewOpenRequest; sessionID?: string }) {
  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    openInPreview(props.request.path, props.sessionID)
  }
  return (
    <button
      type="button"
      data-component="amicode-card"
      data-tool="amicode_open_preview"
      data-state="done"
      data-clickable="true"
      title={props.request.path}
      aria-label={`Open ${props.request.name} in the Preview`}
      onClick={open}
    >
      <span class="amc-body">
        <span class="amc-label" data-slot="amicode-card-stage">
          Preview
        </span>
        <span class="amc-detail" data-slot="amicode-preview-name">
          {props.request.name}
        </span>
      </span>
      <span class="amc-trail">
        <svg class="amc-tick" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-6.5"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </button>
  )
}
