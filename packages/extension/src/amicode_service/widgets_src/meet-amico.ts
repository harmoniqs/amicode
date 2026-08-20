// AMICODE built-in widget: MEET AMICO — identity hero + capabilities + the
// "Open chat" front door. Vanilla DOM, --amc-* tokens only, no backticks or
// ${} inside widgetJs (it ships inside a TS template literal).

export const manifestToml = `
id = "meet-amico"
name = "Meet Amico"
version = "1.0.0"
description = "Who your pal is and what it can do — the front door to a fresh chat"
size = "hero"
height = 250
`

export const widgetJs = `
var CAN = [
  'design pulses from a conversation',
  'optimize for fidelity, speed, or robustness',
  'warm-start from your pulse bank',
  'tune & calibrate on real hardware',
]

// The full amico.svg mark — MarkDetailed geometry from logo.tsx (H-bracket +
// face, viewBox 0 0 3600 3600), sized as a compact brand glyph.
var FACE =
  '<svg viewBox="0 0 3600 3600" width="44" height="44" aria-hidden="true" fill="var(--amc-text-muted)" style="flex-shrink:0;display:block" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M2279.19,374.09v622.56h-958.38V374.09H202.07v2851.83h1118.74v-520.15h958.38v520.15h1118.74V374.09h-1118.74ZM3165.55,2523.71H478.91v-1338.38h2686.65v1338.38Z"/><rect x="1778.31" y="1312.43" width="107.11" height="692.38"/><polygon points="2769.41 1463.57 2903.01 1463.57 2903.01 1601.01 2769.39 1601.01 2769.39 1463.6 2635.79 1463.6 2635.79 1326.16 2769.41 1326.16 2769.41 1463.57"/><polygon points="3036.63 1738.45 2903.03 1738.45 2903.03 1875.89 2769.41 1875.89 2769.41 1738.45 2903.01 1738.45 2903.01 1601.01 3036.63 1601.01 3036.63 1738.45"/><polygon points="2903.02 1875.89 2769.43 1875.89 2769.43 2013.33 2635.81 2013.33 2635.81 1875.89 2769.4 1875.89 2769.4 1738.45 2903.02 1738.45 2903.02 1875.89"/><rect x="2373.03" y="1451.19" width="133.62" height="423.84" transform="translate(4879.6781 3326.2281) rotate(-180)"/><rect x="2009.75" y="1451.19" width="133.62" height="423.84" transform="translate(4153.1112 3326.2281) rotate(-180)"/><rect x="2143.56" y="1313.76" width="229.47" height="137.44" transform="translate(4516.5887 2764.9517) rotate(-180)"/><rect x="2143.56" y="1875.03" width="229.47" height="137.44" transform="translate(4516.5887 3887.5046) rotate(-180)"/><rect x="1503.05" y="1446.71" width="133.62" height="423.84" transform="translate(3139.725 3317.2494) rotate(-180)"/><rect x="1139.77" y="1446.71" width="133.62" height="423.84" transform="translate(2413.1581 3317.2494) rotate(-180)"/><rect x="1273.58" y="1309.27" width="229.47" height="137.44" transform="translate(2776.6357 2755.9729) rotate(-180)"/><rect x="1273.58" y="1870.54" width="229.47" height="137.44" transform="translate(2776.6357 3878.5258) rotate(-180)"/><polygon points="888.52 1864.8 754.93 1864.8 754.93 1727.36 888.55 1727.36 888.55 1864.77 1022.15 1864.77 1022.15 2002.21 888.52 2002.21 888.52 1864.8"/><polygon points="621.31 1589.92 754.9 1589.92 754.9 1452.48 888.52 1452.48 888.52 1589.92 754.93 1589.92 754.93 1727.36 621.31 1727.36 621.31 1589.92"/><polygon points="754.92 1452.48 888.51 1452.48 888.51 1315.04 1022.13 1315.04 1022.13 1452.48 888.54 1452.48 888.54 1589.92 754.92 1589.92 754.92 1452.48"/><rect x="1648.65" y="2256.8" width="349.19" height="137.44" transform="translate(3646.502 4651.0383) rotate(-180)"/><rect x="1510.91" y="2119.73" width="138.82" height="138.82"/><rect x="1997.85" y="2117.98" width="138.82" height="138.82"/></svg>'

export default {
  mount: function (el, amico) {
    var on = function (sel, fn) {
      var n = el.querySelector(sel)
      if (n) n.onclick = fn
    }
    var bullets = CAN.map(function (line) {
      return (
        '<div style="display:flex;gap:6px;align-items:baseline;min-width:0;font-size:12px;line-height:18px;color:var(--amc-text)">' +
        '<span style="color:var(--amc-accent);flex-shrink:0">&rsaquo;</span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + line + '</span></div>'
      )
    }).join('')
    el.innerHTML =
      '<div data-card style="display:flex;flex-direction:column;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:12px;background:var(--amc-layer);padding:var(--amc-pad);cursor:pointer">' +
      '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">Meet Amico</div>' +
      '<div style="display:flex;gap:12px;align-items:center;margin-top:10px">' +
      FACE +
      '<div style="min-width:0">' +
      '<div style="font-size:18px;font-weight:600;color:var(--amc-text)">Amico</div>' +
      '<div style="font-size:12px;line-height:16px;color:var(--amc-text-muted)">Your friendly Quantum Computing Agent</div>' +
      '<div data-engine style="font-size:11px;line-height:16px;color:var(--amc-text-faint)">powered by the Piccolo engine</div>' +
      '</div></div>' +
      '<div style="height:1px;background:var(--amc-border);margin:12px 0"></div>' +
      '<div style="font-size:11px;color:var(--amc-text-muted);margin-bottom:6px">I can help you</div>' +
      '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:12px">' + bullets + '</div>' +
      '<button type="button" data-cta style="align-self:flex-start;display:inline-flex;align-items:center;gap:10px;margin-top:auto;padding:12px 20px;border:1px solid color-mix(in srgb, var(--amc-accent-ink) 14%, transparent);border-radius:8px;cursor:pointer;background:var(--amc-accent-fill);color:var(--amc-accent-ink);font-size:15px;font-weight:650">Open chat <span aria-hidden="true" style="font-size:16px;line-height:1">&#8594;</span></button>' +
      '</div>'
    on('[data-cta]', function (e) {
      e.stopPropagation()
      amico.prompt('')
    })
    on('[data-card]', function () {
      amico.prompt('')
    })
    var applyDensity = function () {
      var engine = el.querySelector('[data-engine]')
      if (engine) engine.style.display = amico.density === 'tight' ? 'none' : ''
    }
    applyDensity()
    amico.onTheme(applyDensity)
  },
}
`
