// AMICODE built-in widget: NOW SOLVING — live run tile. Data via
// amico.context.liveRun (the host keeps polling run-status/run-series);
// config.plot picks pulse (default, per Track 1) or objective sparkline.
// No live run → empty-state. Click opens the Run entity.

export const manifestToml = `
id = "now-solving"
name = "Now solving"
version = "1.0.0"
description = "The run in flight — iteration, fidelity, live sparkline"
size = "tile"
height = 96

[config.plot]
type = "select"
options = ["pulse", "objective"]
default = "pulse"
`

export const widgetJs = `
var W = 96
var H = 22

function scaled(ys, min, max) {
  var span = max - min || 1
  var step = W / (ys.length - 1)
  var d = ''
  for (var i = 0; i < ys.length; i++) {
    var px = (i * step).toFixed(1)
    var py = (H - 2 - ((ys[i] - min) / span) * (H - 4)).toFixed(1)
    d += (i === 0 ? 'M' : ' L') + px + ',' + py
  }
  return d
}

function paths(run, plot) {
  var pulse = run.pulse || []
  if (plot === 'pulse' && pulse.length >= 2) {
    var n = Math.max(1, run.drives || 1)
    var knots = Math.floor(pulse.length / n)
    if (knots >= 2) {
      var min = Math.min.apply(null, pulse)
      var max = Math.max.apply(null, pulse)
      var out = []
      for (var d = 0; d < n; d++) out.push(scaled(pulse.slice(d * knots, (d + 1) * knots), min, max))
      return out
    }
  }
  var series = run.series || []
  if (series.length < 2) return []
  return [scaled(series, Math.min.apply(null, series), Math.max.apply(null, series))]
}

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
      var run = amico.context && amico.context.liveRun
      // tray preview (context.preview): sample run instead of the empty state
      if (!run && amico.context && amico.context.preview) {
        run = {
          name: 'CZ gate \\u2014 transmon pair',
          iteration: 42,
          fidelity: 0.99871,
          series: [1, 0.62, 0.41, 0.28, 0.2, 0.14, 0.1, 0.07, 0.05, 0.035, 0.022, 0.013, 0.008],
        }
      }
      if (!run) {
        el.innerHTML = ''
        return
      }
      var plot = (amico.config && amico.config.plot) || 'pulse'
      var ds = paths(run, plot)
      var svg = ''
      if (ds.length) {
        svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="flex-shrink:0">'
        for (var i = 0; i < ds.length; i++)
          svg += '<path d="' + ds[i] + '" fill="none" stroke="var(--amc-accent)" stroke-width="1.5" stroke-linejoin="round" opacity="' + (i === 0 ? '1' : '0.55') + '"/>'
        svg += '</svg>'
      }
      var f = typeof run.fidelity === 'number' ? run.fidelity.toFixed(5) : '\\u2014'
      var iter = run.iteration == null ? '\\u2014' : String(run.iteration)
      el.innerHTML =
        '<div data-card style="display:flex;flex-direction:column;gap:6px;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:var(--amc-radius);background:var(--amc-layer);padding:var(--amc-pad-tile);cursor:pointer">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">Now solving</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(run.name || 'current run') + '</div>' +
        '<div style="font-size:11px;color:var(--amc-text-muted);font-variant-numeric:tabular-nums">iter ' + iter + ' \\u00b7 F ' + f + '</div>' +
        '<div style="margin-top:auto">' + svg + '</div>' +
        '</div>'
      var card = el.querySelector('[data-card]')
      if (card)
        card.onclick = function () {
          amico.open('run')
        }
    }
    render()
    amico.onContext(render)
    amico.onConfig(render)
  },
}
`
