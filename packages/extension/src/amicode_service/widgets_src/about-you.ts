// AMICODE built-in widget: ABOUT YOU — profile hero with earned stats (which
// stats show is user config), "Amico remembers", and in-place identity edit.
// Institution suggestions + logo resolution + external links + saves all go
// through host actions (widget frames have no network). Declared v1
// degradation: no clipboard text-paste fallback on the edit inputs.

export const manifestToml = `
id = "about-you"
name = "About you"
version = "1.0.0"
description = "Your profile, earned stats, and what Amico remembers"
size = "hero"
height = 250

[config.stats]
type = "multi-select"
options = ["problems", "runs"]
default = ["problems", "runs"]
`

export const widgetJs = `
export default {
  mount: function (el, amico) {
    var profile = null
    var editing = false
    var saving = false
    var draft = { name: '', affiliation: '', focus: '', scholar: '', affiliation_logo: '' }
    var suggestions = []
    var searchTimer = null
    var searchSeq = 0

    var esc = function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }
    var initials = function (name) {
      var parts = String(name || '').trim().split(/\\s+/).filter(Boolean)
      if (parts.length === 0) return '?'
      return parts.slice(0, 2).map(function (p) { return p[0].toUpperCase() }).join('')
    }
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    var sinceLabel = function (iso) {
      if (!iso) return null
      var m = String(iso).match(/^(\\d{4})-(\\d{2})-(\\d{2})$/)
      if (!m) return null
      var label = 'since ' + (MONTHS[Number(m[2]) - 1] || m[2]) + ' ' + Number(m[3])
      var started = Date.parse(iso)
      if (isNaN(started)) return label
      var days = Math.max(0, Math.round((Date.now() - started) / 86400000))
      return days <= 0 ? label + ' \\u00b7 today' : label + ' \\u00b7 ' + days + ' day' + (days === 1 ? '' : 's')
    }
    var on = function (sel, evt, fn) {
      var n = el.querySelector(sel)
      if (n) n['on' + evt] = fn
    }

    var statBlock = function (value, label) {
      return (
        '<div style="display:flex;flex-direction:column;gap:1px;min-width:0">' +
        '<span style="font-size:16px;font-weight:600;color:var(--amc-text);font-variant-numeric:tabular-nums;line-height:20px">' + value + '</span>' +
        '<span style="font-size:10px;color:var(--amc-text-faint);line-height:12px">' + label + '</span></div>'
      )
    }

    var render = function () {
      if (!profile || !profile.ok) {
        el.innerHTML = ''
        return
      }
      var you = profile.you
      var stats = you.stats || {}
      var chosen = (amico.config && amico.config.stats) || ['problems', 'runs']
      var fresh = !stats.problems && !stats.runs

      var avatar = you.avatar
        ? '<img src="' + esc(you.avatar) + '" alt="" onerror="this.style.display=\\'none\\'" style="width:44px;height:44px;border-radius:var(--amc-radius);object-fit:cover;flex-shrink:0">'
        : '<div style="width:44px;height:44px;flex-shrink:0;border-radius:var(--amc-radius);background:var(--amc-layer2);color:var(--amc-text-muted);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600">' + esc(initials(you.name)) + '</div>'

      var platforms = (you.platforms || []).slice(0, 3).map(function (p) {
        return '&#9671; ' + esc(p)
      }).join('&nbsp;&nbsp;')

      var editForm =
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">' +
        '<input data-f-name placeholder="name" value="' + esc(draft.name) + '" style="font-size:12px;padding:4px 8px;border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);background:var(--amc-bg);color:var(--amc-text)">' +
        '<div style="position:relative">' +
        '<input data-f-affiliation placeholder="affiliation" value="' + esc(draft.affiliation) + '" autocomplete="off" style="width:100%;box-sizing:border-box;font-size:12px;padding:4px 8px;border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);background:var(--amc-bg);color:var(--amc-text)">' +
        (suggestions.length
          ? '<div style="position:absolute;left:0;right:0;top:100%;z-index:5;background:var(--amc-layer2);border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);overflow:hidden">' +
            suggestions.map(function (s, i) {
              return '<div data-sugg="' + i + '" style="padding:5px 8px;font-size:12px;color:var(--amc-text);cursor:pointer">' + esc(s.name) + ' <span style="color:var(--amc-text-faint)">' + esc(s.domain || '') + '</span></div>'
            }).join('') + '</div>'
          : '') +
        '</div>' +
        '<input data-f-focus placeholder="research area (e.g. optimal control, ML, materials science)" value="' + esc(draft.focus) + '" style="font-size:12px;padding:4px 8px;border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);background:var(--amc-bg);color:var(--amc-text)">' +
        '<input data-f-scholar placeholder="Google Scholar URL" value="' + esc(draft.scholar) + '" style="font-size:12px;padding:4px 8px;border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);background:var(--amc-bg);color:var(--amc-text)">' +
        '<div style="display:flex;gap:8px">' +
        '<button type="button" data-save ' + (saving ? 'disabled' : '') + ' style="font-size:12px;padding:4px 12px;border:1px solid var(--amc-accent);border-radius:var(--amc-radius-sm);background:var(--amc-layer2);color:var(--amc-text);cursor:pointer">' + (saving ? 'Saving\\u2026' : 'Save') + '</button>' +
        '<button type="button" data-cancel style="font-size:12px;padding:4px 12px;border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);background:transparent;color:var(--amc-text-muted);cursor:pointer">Cancel</button>' +
        '</div></div>'

      var identity =
        '<div style="display:flex;gap:12px;align-items:flex-start;margin-top:10px">' + avatar +
        '<div style="min-width:0;flex:1">' +
        '<div style="display:flex;align-items:baseline;gap:8px">' +
        '<div style="font-size:18px;font-weight:600;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(you.name || 'You') + '</div>' +
        (you.scholar ? '<span data-scholar style="font-size:11px;color:var(--amc-accent);cursor:pointer;flex-shrink:0">scholar &#8599;</span>' : '') +
        '<span data-edit title="Edit profile" style="margin-left:auto;color:var(--amc-text-faint);cursor:pointer;flex-shrink:0;font-size:18px;line-height:1;display:inline-block;transform:scaleX(-1)">&#9998;</span>' +
        '</div>' +
        (editing
          ? editForm
          : '<div style="font-size:12px;line-height:16px;color:var(--amc-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            esc(you.focus || you.affiliation || 'tell Amico about your work') + '</div>' +
            (you.description ? '<div style="font-size:11px;line-height:15px;color:var(--amc-text-muted);margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc(you.description) + '</div>' : '') +
            (platforms ? '<div style="font-size:11px;color:var(--amc-text-faint);margin-top:1px">' + platforms + '</div>' : '')) +
        '</div></div>'

      var body
      if (fresh && !editing) {
        body =
          '<div style="height:1px;background:var(--amc-border);margin:12px 0"></div>' +
          '<div style="font-size:12px;color:var(--amc-text-muted);margin-bottom:8px">No experiments yet \\u2014 tell Amico what you&#39;re working on and it&#39;ll start remembering.</div>' +
          '<button type="button" data-firstrun style="align-self:flex-start;border:1px solid var(--amc-accent);border-radius:var(--amc-radius-sm);background:var(--amc-layer2);color:var(--amc-text);padding:5px 12px;font-size:12px;cursor:pointer">Get started &#8594;</button>'
      } else if (!editing) {
        var cells = chosen.map(function (k) {
          return statBlock(String(stats[k] == null ? 0 : stats[k]), k)
        }).join('')
        var remembers = (you.remembers || []).map(function (r) {
          return '<div title="' + esc(r.detail) + '" style="display:flex;gap:6px;align-items:baseline;min-width:0;font-size:12px;line-height:18px;color:var(--amc-text)">' +
            '<span style="color:var(--amc-accent);flex-shrink:0">&rsaquo;</span>' +
            '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.title) + '</span></div>'
        }).join('')
        var since = sinceLabel(stats.since)
        body =
          '<div style="height:1px;background:var(--amc-border);margin:12px 0"></div>' +
          '<div style="display:grid;grid-template-columns:repeat(' + Math.max(1, chosen.length) + ',minmax(0,1fr));gap:8px">' + cells + '</div>' +
          (remembers
            ? '<div style="height:1px;background:var(--amc-border);margin:12px 0"></div>' +
              '<div style="font-size:11px;color:var(--amc-text-muted);margin-bottom:6px">Amico remembers</div>' +
              '<div style="display:flex;flex-direction:column;gap:3px">' + remembers + '</div>'
            : '') +
          (since ? '<div style="font-size:10px;color:var(--amc-text-faint);margin-top:10px">' + since + '</div>' : '')
      } else {
        body = ''
      }

      el.innerHTML =
        '<div style="display:flex;flex-direction:column;min-width:0;height:100vh;overflow-y:auto;border:1px solid var(--amc-border);border-radius:var(--amc-radius);background:var(--amc-layer);padding:var(--amc-pad)">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">About you</div>' +
        identity + body + '</div>'

      on('[data-edit]', 'click', function () {
        editing = !editing
        if (editing) {
          suggestions = []
          draft = {
            name: you.name || '',
            affiliation: you.affiliation || '',
            focus: you.focus || '',
            scholar: you.scholar || '',
            affiliation_logo: you.affiliation_logo || '',
          }
        }
        render()
      })
      on('[data-scholar]', 'click', function () {
        amico.action('open-external', { url: you.scholar })
      })
      on('[data-firstrun]', 'click', function () {
        amico.prompt('help me get started with my first project')
      })
      on('[data-cancel]', 'click', function () {
        editing = false
        suggestions = []
        render()
      })
      on('[data-save]', 'click', function () {
        var read = function (sel) {
          var n = el.querySelector(sel)
          return n ? n.value : ''
        }
        draft.name = read('[data-f-name]')
        draft.affiliation = read('[data-f-affiliation]')
        draft.focus = read('[data-f-focus]')
        draft.scholar = read('[data-f-scholar]')
        saving = true
        render()
        amico
          .action('save-profile', draft)
          .then(function () { return amico.fetch('/amicode/profile') })
          .then(function (fresh) {
            profile = fresh
            saving = false
            editing = false
            suggestions = []
            render()
          })
          .catch(function () {
            saving = false
            render()
          })
      })
      on('[data-f-affiliation]', 'input', function (e) {
        var q = e.target.value
        draft.affiliation = q
        if (searchTimer) clearTimeout(searchTimer)
        if (String(q).trim().length < 2) {
          searchSeq++
          suggestions = []
          return
        }
        searchTimer = setTimeout(function () {
          var seq = ++searchSeq
          amico.action('lookup-institution', { query: q }).then(function (rows) {
            if (seq !== searchSeq) return
            suggestions = Array.isArray(rows) ? rows.slice(0, 5) : []
            render()
            var input = el.querySelector('[data-f-affiliation]')
            if (input) {
              input.focus()
              input.setSelectionRange(input.value.length, input.value.length)
            }
          }).catch(function () {})
        }, 200)
      })
      var suggNodes = el.querySelectorAll('[data-sugg]')
      for (var i = 0; i < suggNodes.length; i++) {
        ;(function (node) {
          node.onclick = function () {
            var pick = suggestions[Number(node.getAttribute('data-sugg'))]
            if (!pick) return
            draft.affiliation = pick.name
            suggestions = []
            amico.action('resolve-logo', { name: pick.name, domain: pick.domain }).then(function (r) {
              if (r && typeof r.logo === 'string') draft.affiliation_logo = r.logo
            }).catch(function () {})
            render()
          }
        })(suggNodes[i])
      }
    }

    el.innerHTML = ''
    amico.fetch('/amicode/profile').then(function (data) {
      profile = data
      render()
    }).catch(function (e) {
      // a hero card must never fail invisibly — show the reason
      el.innerHTML =
        '<div style="border:1px solid var(--amc-border);border-radius:var(--amc-radius);background:var(--amc-layer);padding:var(--amc-pad);font-size:11px;color:var(--amc-text-muted)">' +
        'About you: profile unavailable (' + String(e && e.message ? e.message : e) + ')</div>'
    })
    amico.onConfig(function () { render() })
  },
}
`
