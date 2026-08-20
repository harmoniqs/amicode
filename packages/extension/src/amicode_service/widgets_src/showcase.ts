// AMICODE built-in widget: SHOWCASE — trophy-case entry point to the run
// gallery. Static tile; the click is a host navigation action.

export const manifestToml = `
id = "showcase"
name = "Showcase"
version = "1.0.0"
description = "Run gallery — shareable cards of your solves"
size = "tile"
height = 140
`

export const widgetJs = `
export default {
  mount: function (el, amico) {
    el.innerHTML =
      '<div data-card style="display:flex;flex-direction:column;gap:6px;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:12px;background:var(--amc-layer);padding:var(--amc-pad-tile);cursor:pointer">' +
      '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">Showcase</div>' +
      '<div style="font-size:13px;font-weight:600;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Run gallery</div>' +
      '<div style="font-size:11px;color:var(--amc-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">shareable cards of your solves</div>' +
      '<div style="font-size:11px;color:var(--amc-accent);margin-top:auto">Browse &amp; share &#8594;</div>' +
      '</div>'
    var card = el.querySelector('[data-card]')
    if (card)
      card.onclick = function () {
        amico.action('open-gallery', {})
      }
  },
}
`
