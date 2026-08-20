// AMICODE built-in widget: JUMP BACK IN — resume the most recent problem
// session. Data arrives via amico.context.resume (host session state, no
// endpoint); no resume → renders nothing (height-0 empty-state).

export const manifestToml = `
id = "jump-back-in"
name = "Jump back in"
version = "1.0.0"
description = "Resume your most recent problem session"
size = "tile"
height = 140
`

export const widgetJs = `
export default {
  mount: function (el, amico) {
    var esc = function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }
    var render = function () {
      var resume = amico.context && amico.context.resume
      // tray preview (context.preview): sample session instead of the empty state
      if ((!resume || !resume.name) && amico.context && amico.context.preview) {
        resume = { name: 'CZ gate \\u2014 transmon pair', meta: '3 runs \\u00b7 best F 0.9987' }
      }
      if (!resume || !resume.name) {
        el.innerHTML = ''
        return
      }
      el.innerHTML =
        '<div data-card style="display:flex;flex-direction:column;gap:6px;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:12px;background:var(--amc-layer);padding:var(--amc-pad-tile);cursor:pointer">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">Jump back in</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(resume.name) + '</div>' +
        (resume.meta
          ? '<div style="font-size:11px;color:var(--amc-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(resume.meta) + '</div>'
          : '') +
        '<div style="font-size:11px;color:var(--amc-accent);margin-top:auto">Resume &#8594;</div>' +
        '</div>'
      var card = el.querySelector('[data-card]')
      if (card)
        card.onclick = function () {
          amico.action('resume-session', {})
        }
    }
    render()
    amico.onContext(render)
  },
}
`
