import { describe, expect, test } from "bun:test"
import { createEffect } from "solid-js"
import { createComponent, render } from "solid-js/web"
import EmptyWorkspaceLanding from "../src/pages/empty-workspace-landing"

type Child = Node | string | number | boolean | null | undefined | Child[]
type Props = Record<string, unknown>

// Bun's test transpiler does not apply Solid's DOM transform to imported JSX
// modules. This tiny JSX adapter is intentionally limited to the static DOM
// surface the landing owns; it lets the test render the real component without
// providing any app or directory context.
function appendChildren(parent: Element, children: Child[]) {
  for (const child of children.flat(Infinity) as Exclude<Child, Child[]>[]) {
    if (child === null || child === undefined || child === false) continue
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

function createElement(type: string | ((props: Props) => Child), props: Props | null, ...children: Child[]): Child {
  if (typeof type === "function") {
    return type({ ...props, children: children.length === 1 ? children[0] : children })
  }

  const element = document.createElement(type)
  for (const [name, value] of Object.entries(props ?? {})) {
    if (name === "children" || value === undefined || value === null || value === false) continue
    if (name === "class") {
      element.className = String(value)
      continue
    }
    if (name.startsWith("on") && typeof value === "function") {
      element.addEventListener(name.slice(2).toLowerCase(), value as EventListener)
      continue
    }
    element.setAttribute(name, value === true ? "" : String(value))
  }
  appendChildren(element, children)
  return element
}

describe("EmptyWorkspaceLanding (#1458)", () => {
  test("renders provider-free, leaves the landing draft effect live, and requests Open Folder", async () => {
    const host = document.createElement("div")
    const originalParent = window.parent
    const reactHost = globalThis as typeof globalThis & { React?: { createElement: typeof createElement } }
    const originalReact = reactHost.React
    const messages: unknown[][] = []
    let dispose: (() => void) | undefined
    let draftEffectRuns = 0

    Object.defineProperty(window, "parent", {
      configurable: true,
      value: {
        postMessage: (...args: unknown[]) => messages.push(args),
      },
    })
    Object.defineProperty(reactHost, "React", {
      configurable: true,
      value: { createElement },
    })

    try {
      document.body.append(host)
      const LandingRoute = () => {
        // This models NewSessionLanding's sibling reactive draft effect. The
        // provider-free empty landing must not abort the route tree before it
        // can react when a workspace arrives.
        createEffect(() => {
          draftEffectRuns += 1
        })
        return createComponent(EmptyWorkspaceLanding, {})
      }

      expect(() => {
        dispose = render(() => createComponent(LandingRoute, {}), host)
      }).not.toThrow()

      await Promise.resolve()
      expect(draftEffectRuns).toBe(1)

      const openFolder = host.querySelector("button")
      expect(openFolder?.textContent).toContain("Open a folder to get started")
      openFolder?.click()
      expect(messages).toEqual([[{ source: "amicode", kind: "add-workspace-project" }, "*"]])
    } finally {
      dispose?.()
      host.remove()
      Object.defineProperty(window, "parent", {
        configurable: true,
        value: originalParent,
      })
      if (originalReact === undefined) Reflect.deleteProperty(reactHost, "React")
      else {
        Object.defineProperty(reactHost, "React", {
          configurable: true,
          value: originalReact,
        })
      }
    }
  })
})
