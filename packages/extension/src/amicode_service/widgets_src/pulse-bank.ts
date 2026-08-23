// AMICODE built-in widget: PULSE BANK — banked-pulse count + the warm-start
// entry point. Fetches /amicode/profile itself; banked === 0 → empty-state.

export const manifestToml = `
id = "pulse-bank"
name = "Pulse bank"
version = "1.0.0"
description = "Banked pulses at a glance — warm-start entry point"
size = "tile"
height = 140
`

export const widgetJs = `
export default {
  mount: function (el, amico) {
    var render = function (banked) {
      // tray preview (context.preview): sample count instead of the empty state
      if ((!banked || banked < 1) && amico.context && amico.context.preview) banked = 12
      if (!banked || banked < 1) {
        el.innerHTML = ''
        return
      }
      el.innerHTML =
        '<div data-card style="display:flex;flex-direction:column;gap:6px;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:var(--amc-radius);background:var(--amc-layer);padding:var(--amc-pad-tile);cursor:pointer">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">Pulse bank</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        banked + ' pulse' + (banked === 1 ? '' : 's') + ' banked</div>' +
        '<div style="font-size:11px;color:var(--amc-accent);margin-top:auto">Warm-start &#8594;</div>' +
        '</div>'
      var card = el.querySelector('[data-card]')
      if (card)
        card.onclick = function () {
          amico.action('warm-start', {})
        }
    }
    el.innerHTML = ''
    amico
      .fetch('/amicode/profile')
      .then(function (data) {
        var banked = data && data.ok && data.you && data.you.stats ? data.you.stats.banked : 0
        render(typeof banked === 'number' ? banked : 0)
      })
      .catch(function () {
        render(0)
      })
  },
}
`
