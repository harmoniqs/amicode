// AMICODE built-in widget: LIBRARY — "make Amico smarter" paper uploads.
// Count/latest via amico.context.library; the PDF bytes ride the
// upload-library host action (base64); "Discuss latest" opens a chat.

export const manifestToml = `
id = "library"
name = "Library"
version = "1.0.0"
description = "Upload papers — Amico learns your work"
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
    var busy = false
    var render = function () {
      var lib = (amico.context && amico.context.library) || { count: 0 }
      el.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:6px;min-width:0;height:100vh;border:1px solid var(--amc-border);border-radius:var(--amc-radius);background:var(--amc-layer);padding:var(--amc-pad-tile)">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amc-text-faint)">Library</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--amc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Make Amico smarter</div>' +
        '<div style="font-size:11px;color:var(--amc-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        (lib.count > 0 ? lib.count + ' paper' + (lib.count === 1 ? '' : 's') + ' \\u00b7 latest: ' + esc(lib.latestName || '') : 'upload papers \\u2014 Amico learns your work') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:auto;align-items:flex-start">' +
        '<button type="button" data-upload ' + (busy ? 'disabled' : '') + ' style="font-size:11px;padding:3px 10px;border:1px solid var(--amc-border);border-radius:var(--amc-radius-sm);background:var(--amc-layer2);color:var(--amc-text);cursor:pointer">' + (busy ? 'Uploading\\u2026' : 'Upload PDF') + '</button>' +
        (lib.latestPath ? '<span data-discuss style="font-size:11px;color:var(--amc-accent);cursor:pointer">Discuss latest &#8594;</span>' : '') +
        '</div>' +
        '<input data-file type="file" accept=".pdf,application/pdf" style="display:none">' +
        '</div>'
      var upload = el.querySelector('[data-upload]')
      var file = el.querySelector('[data-file]')
      if (upload && file)
        upload.onclick = function () {
          file.click()
        }
      if (file)
        file.onchange = function () {
          var f = file.files && file.files[0]
          if (!f) return
          busy = true
          render()
          var reader = new FileReader()
          reader.onload = function () {
            var url = String(reader.result || '')
            var b64 = url.slice(url.indexOf(',') + 1)
            amico.action('upload-library', { filename: f.name, dataB64: b64 }).then(function () {
              busy = false
              render()
            }).catch(function () {
              busy = false
              render()
            })
          }
          reader.onerror = function () {
            busy = false
            render()
          }
          reader.readAsDataURL(f)
        }
      var discuss = el.querySelector('[data-discuss]')
      if (discuss)
        discuss.onclick = function () {
          var lib2 = (amico.context && amico.context.library) || {}
          amico.prompt('read my latest paper at ' + (lib2.latestPath || '') + ' and discuss how it should inform my pulse-design work')
        }
    }
    render()
    amico.onContext(render)
  },
}
`
