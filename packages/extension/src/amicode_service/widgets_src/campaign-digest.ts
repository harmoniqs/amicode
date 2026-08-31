// AMICODE built-in widget: CAMPAIGN DIGEST — the home-dashboard digest over
// the campaign routes (#678, data contract #658/#662): GET /amicode/campaigns
// (newest-first list) + GET /amicode/campaign?slug= (the ledger's parsed
// sections). The tile renders the active campaign's one-line objective, the
// newest verdict-table entries as compact chips, and the §4 blocked section
// as the needs-you line. Mechanical projection only — the tile renders what
// the routes return, no ledger-markdown parsing beyond display compression
// of the status cells. Any fetch failure or a campaign-less ledger dir
// renders nothing (height-0 empty-state, the jump-back-in discipline).

export const manifestToml = `
id = "campaign-digest"
name = "Campaign digest"
version = "1.0.0"
description = "Live digest of your active research campaign — objective, verdicts, needs-you"
size = "tile"
height = 150
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
    // Verdict chips: the §2 table's data rows (row 0 is the header per the
    // route contract). A chip is the first cell (the slice/unit) plus the
    // status cell's leading token — display compression of the raw cell,
    // not parsing: ledgers write '**DONE** — PR #17 merged …' and the chip
    // shows 'DONE'.
    var MAX_VERDICT_CHIPS = 3
    var showEmpty = function () {
      el.innerHTML = ''
    }
    var statusToken = function (cell) {
      return String(cell || '')
        .split('**').join('')
        .split('\\u2014')[0]
        .split('\\u2013')[0]
        .trim()
        .split(/\\s+/)
        .slice(0, 2)
        .join(' ')
    }
    var chipTone = function (cell) {
      var s = String(cell || '').toUpperCase()
      if (s.indexOf('DONE') >= 0 || s.indexOf('MERGED') >= 0 || s.indexOf('PASS') >= 0) return 'var(--amc-success)'
      if (s.indexOf('BLOCK') >= 0 || s.indexOf('FAIL') >= 0 || s.indexOf('STUCK') >= 0) return 'var(--amc-danger)'
      return 'var(--amc-accent)'
    }
    // Pick the newest campaign whose status is ACTIVE (case-insensitive —
    // ledgers write 'ACTIVE' in the frontmatter), falling back to the newest
    // overall: a finished campaign still deserves a tile until the next one
    // starts. The list is newest-first per the route contract, so the first
    // match wins.
    var pickCampaign = function (campaigns) {
      if (!campaigns || campaigns.length === 0) return null
      for (var i = 0; i < campaigns.length; i++) {
        var status = String((campaigns[i] && campaigns[i].status) || '').toLowerCase()
        if (status === 'active') return campaigns[i]
      }
      return campaigns[0]
    }
    // First non-empty line of a section body, bullet + bold markers
    // stripped (the same mechanical projection the list route applies to
    // the objective line).
    var firstLine = function (text) {
      var lines = String(text || '').split('\\n')
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim().replace(/^[-*]\\s+/, '').split('**').join('')
        if (line !== '') return line
      }
      return ''
    }
    var renderCard = function (entry, detail) {
      var slug = entry.slug
      var eyebrow = entry.campaign || 'Campaign digest'
      var objective = String(entry.objective || '')
      var blocked = firstLine(detail.blocked)
      var chips = ''
      var rows = (detail.verdicts || []).slice(1, 1 + MAX_VERDICT_CHIPS)
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i]
        if (!row || row.length < 2) continue
        var label = statusToken(row[row.length - 1])
        if (label === '') continue
        chips +=
          '<span style="font-size:10px;font-weight:600;padding:1px 7px;border-radius:8px;border:1px solid var(--amc-border);color:' +
          chipTone(row[row.length - 1]) +
          ';white-space:nowrap">' +
          esc(row[0]) +
          ' \\u00b7 ' +
          esc(label) +
          '</span>'
      }
      el.innerHTML =
        '<div data-card style="display:flex;flex-direction:column;gap:6px;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:var(--amc-radius);background:var(--amc-layer);padding:var(--amc-pad-tile);cursor:pointer">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        esc(eyebrow) +
        '</div>' +
        (objective !== ''
          ? '<div style="font-size:12px;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            esc(objective) +
            '</div>'
          : '') +
        (chips !== '' ? '<div style="display:flex;gap:4px;flex-wrap:wrap;overflow:hidden">' + chips + '</div>' : '') +
        '<div style="font-size:11px;color:' +
        (blocked !== '' ? 'var(--amc-warning)' : 'var(--amc-text-faint)') +
        ';margin-top:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        (blocked !== '' ? '\\u26a0 needs you \\u2014 ' + esc(blocked) : 'nothing blocked') +
        '</div>' +
        '</div>'
      var card = el.querySelector('[data-card]')
      if (card)
        card.onclick = function () {
          amico.prompt('Open the campaign ' + slug)
        }
    }
    var epoch = 0
    var render = function () {
      var mine = ++epoch
      amico
        .fetch('/amicode/campaigns')
        .then(function (data) {
          if (mine !== epoch) return undefined
          if (!data || data.ok === false) return showEmpty()
          var picked = pickCampaign(data.campaigns)
          if (!picked || !picked.slug) return showEmpty()
          return amico
            .fetch('/amicode/campaign?slug=' + encodeURIComponent(picked.slug))
            .then(function (detail) {
              if (mine !== epoch) return undefined
              if (!detail || detail.ok === false || !detail.campaign) return showEmpty()
              renderCard(picked, detail.campaign)
            })
        })
        .catch(function () {
          if (mine === epoch) showEmpty()
        })
    }
    render()
    // Re-render on host config/theme pushes (the jump-back-in pattern);
    // the epoch guard drops a stale fetch's late write.
    amico.onConfig(render)
    amico.onTheme(render)
  },
}
`
