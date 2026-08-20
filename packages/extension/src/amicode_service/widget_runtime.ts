// AMICODE (widget kernel): the runtime injected into every widget frame, as a
// source string so srcdoc assembly stays a pure tested function. Implements
// the frame side of bridge protocol v1: builds the `amico` client, applies
// theme tokens + density to :root, evaluates the widget module via blob
// import (the only sanctioned eval path — CSP has no 'unsafe-eval'), mounts
// it, and reports content height from a ResizeObserver on the root node.
// Any failure becomes amc:error → the host swaps in the error card.

export const RUNTIME_JS = `
;(function () {
  'use strict'
  var pending = {}
  var nextId = 1
  var configCbs = []
  var themeCbs = []
  var contextCbs = []
  var amico = null
  var mounted = false

  function post(msg) {
    window.parent.postMessage(msg, '*')
  }
  function fail(message) {
    post({ t: 'amc:error', message: String(message) })
  }
  window.onerror = function (msg) {
    fail(msg)
  }
  window.onunhandledrejection = function (e) {
    fail(e && e.reason ? e.reason : 'unhandled rejection')
  }

  function applyTheme(theme, density) {
    var root = document.documentElement
    if (theme) for (var k in theme) root.style.setProperty(k, theme[k])
    if (density) root.setAttribute('data-density', density)
  }

  function request(t, fields) {
    var id = nextId++
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject }
      var msg = { t: t, id: id }
      for (var k in fields) msg[k] = fields[k]
      post(msg)
    })
  }

  function makeAmico(init) {
    return {
      config: init.config || {},
      theme: init.theme || {},
      density: init.density || 'normal',
      context: init.context || {},
      fetch: function (path) {
        return request('amc:fetch', { path: path })
      },
      action: function (verb, payload) {
        return request('amc:action', { verb: verb, payload: payload || {} })
      },
      prompt: function (text) {
        post({ t: 'amc:prompt', text: String(text == null ? '' : text) })
      },
      open: function (entity) {
        post({ t: 'amc:open', entity: String(entity == null ? '' : entity) })
      },
      onConfig: function (cb) {
        configCbs.push(cb)
      },
      onTheme: function (cb) {
        themeCbs.push(cb)
      },
      onContext: function (cb) {
        contextCbs.push(cb)
      },
    }
  }

  function fire(cbs) {
    for (var i = 0; i < cbs.length; i++) {
      try {
        cbs[i]()
      } catch (e) {
        fail(e)
      }
    }
  }

  window.addEventListener('message', function (e) {
    var msg = e.data
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'amc:result') {
      var p = pending[msg.id]
      if (!p) return
      delete pending[msg.id]
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error || 'bridge error'))
      return
    }
    if (msg.t === 'amc:init') {
      if (mounted) return
      mounted = true
      applyTheme(msg.theme, msg.density)
      amico = makeAmico(msg)
      var code = window.__amcWidgetCode
      var blob = new Blob([code], { type: 'text/javascript' })
      var url = URL.createObjectURL(blob)
      import(url)
        .then(function (mod) {
          if (!mod || !mod.default || typeof mod.default.mount !== 'function')
            throw new Error('widget module must export default { mount }')
          var root = document.getElementById('amc-root')
          mod.default.mount(root, amico)
          // Emptiness is an EXPLICIT signal, not inferred from height: a
          // hidden (display:none) frame has no layout, so ResizeObserver
          // stays silent and a height-based hide can never un-hide — the
          // empty-state deadlock. MutationObserver fires regardless of
          // layout: content arriving in a hidden frame un-hides the cell,
          // layout starts, and the ResizeObserver takes over for sizing.
          var isEmpty = function () {
            return root.childElementCount === 0 && (root.textContent || '').trim() === ''
          }
          var lastEmpty = null
          var postEmpty = function () {
            var e = isEmpty()
            if (e !== lastEmpty) {
              lastEmpty = e
              post({ t: 'amc:empty', empty: e })
            }
          }
          var mo = new MutationObserver(postEmpty)
          mo.observe(root, { childList: true, subtree: true, characterData: true })
          var ro = new ResizeObserver(function () {
            post({ t: 'amc:height', h: Math.ceil(root.getBoundingClientRect().height) })
          })
          ro.observe(root)
          postEmpty()
          post({ t: 'amc:height', h: Math.ceil(root.getBoundingClientRect().height) })
        })
        .catch(function (e) {
          fail(e)
        })
      return
    }
    if (!amico) return
    if (msg.t === 'amc:config') {
      amico.config = msg.config || {}
      fire(configCbs)
    } else if (msg.t === 'amc:theme') {
      amico.theme = msg.theme || {}
      amico.density = msg.density || amico.density
      applyTheme(msg.theme, msg.density)
      fire(themeCbs)
    } else if (msg.t === 'amc:context') {
      amico.context = msg.context || {}
      fire(contextCbs)
    }
  })

  post({ t: 'amc:ready' })
})()
`
