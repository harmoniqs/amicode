import { describe, expect, test } from "bun:test"
import { createSignal, Show, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"

/**
 * Tests for the file-name picker dropdown in the diff viewer's file header.
 *
 * FileNameWithPicker renders the filename as a clickable trigger. When clicked,
 * it opens a dropdown and renders the `filePicker` render prop inside it.
 * The filePicker receives an `onSelect` callback; calling it closes the
 * dropdown and fires `onSelectFile`.
 *
 * Uses createComponent (imperative SolidJS API) since bun's test runner
 * does not apply the Solid JSX transform.
 */

function getFilename(path: string) {
  return path.split("/").pop() ?? path
}

function getDirectory(path: string) {
  const parts = path.split("/")
  return parts.length > 1 ? parts.slice(0, -1).join("/") : undefined
}

/** Minimal reproduction of FileNameWithPicker's behavioral contract. */
function FileNameWithPicker(props: {
  file: string
  filePicker?: (pickerProps: { onSelect: (path: string) => void }) => JSX.Element
  onSelectFile?: (file: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const hasFilePicker = () => !!props.filePicker && !!props.onSelectFile

  const toggle = (e: MouseEvent) => {
    e.stopPropagation()
    setOpen(!open())
  }

  const onSelect = (file: string) => {
    setOpen(false)
    props.onSelectFile?.(file)
  }

  return createComponent(Show, {
    keyed: true,
    get when() { return hasFilePicker() },
    get fallback() {
      const span = document.createElement("span")
      span.setAttribute("data-slot", "session-review-v2-file-name")
      span.textContent = getFilename(props.file)
      return span
    },
    get children() {
      const wrapper = document.createElement("div")
      wrapper.className = "session-review-v2-file-picker-wrapper"

      const trigger = document.createElement("button")
      trigger.type = "button"
      trigger.className = "session-review-v2-file-picker-trigger"
      trigger.setAttribute("data-testid", "file-picker-trigger")
      trigger.addEventListener("click", toggle as any)

      const nameSpan = document.createElement("span")
      nameSpan.setAttribute("data-slot", "session-review-v2-file-name")
      nameSpan.setAttribute("data-clickable", "")
      nameSpan.textContent = getFilename(props.file)
      trigger.appendChild(nameSpan)

      wrapper.appendChild(trigger)

      // Reactive dropdown
      const dropdownContainer = document.createElement("div")
      wrapper.appendChild(dropdownContainer)

      const { createEffect } = require("solid-js")
      createEffect(() => {
        dropdownContainer.innerHTML = ""
        if (!open()) return

        const dropdown = document.createElement("div")
        dropdown.className = "session-review-v2-file-picker-dropdown"
        dropdown.setAttribute("data-testid", "file-picker-dropdown")

        // Scroll-inner wrapper (mirrors real component)
        const scrollInner = document.createElement("div")
        scrollInner.className = "session-review-v2-file-picker-scroll-inner"

        // Render the filePicker content inside the scroll wrapper
        const pickerContent = props.filePicker!({ onSelect })
        if (pickerContent instanceof Node) {
          scrollInner.appendChild(pickerContent)
        }

        dropdown.appendChild(scrollInner)
        dropdownContainer.appendChild(dropdown)

        // Cap max-width to remaining panel space (mirrors real component's ref callback)
        requestAnimationFrame(() => {
          const left = dropdown.getBoundingClientRect().left
          const available = window.innerWidth - left - 16
          dropdown.style.maxWidth = `${Math.max(200, available)}px`
        })
      })

      return wrapper
    },
  })
}

describe("FileNameWithPicker (render prop)", () => {
  function mount(props: {
    file: string
    filePicker?: (p: { onSelect: (path: string) => void }) => JSX.Element
    onSelectFile?: (f: string) => void
  }) {
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = render(() => createComponent(FileNameWithPicker, props), host)
    return { host, dispose, cleanup: () => { dispose(); host.remove() } }
  }

  test("dropdown renders the filePicker content when trigger is clicked", () => {
    const { host, cleanup } = mount({
      file: "src/foo.ts",
      filePicker: ({ onSelect }) => {
        const div = document.createElement("div")
        div.setAttribute("data-testid", "mock-tree")
        div.textContent = "tree content"
        return div
      },
      onSelectFile: () => {},
    })

    // Initially closed
    expect(host.querySelector("[data-testid='file-picker-dropdown']")).toBeNull()

    // Click trigger
    const trigger = host.querySelector("[data-testid='file-picker-trigger']") as HTMLButtonElement
    trigger.click()

    // Dropdown open with filePicker content inside
    const dropdown = host.querySelector("[data-testid='file-picker-dropdown']")
    expect(dropdown).not.toBeNull()
    const tree = dropdown!.querySelector("[data-testid='mock-tree']")
    expect(tree).not.toBeNull()
    expect(tree!.textContent).toBe("tree content")

    cleanup()
  })

  test("calling onSelect closes the dropdown and fires onSelectFile", () => {
    let selectCallback: ((path: string) => void) | undefined
    const selected: string[] = []

    const { host, cleanup } = mount({
      file: "src/foo.ts",
      filePicker: ({ onSelect }) => {
        selectCallback = onSelect
        const div = document.createElement("div")
        div.setAttribute("data-testid", "mock-tree")
        return div
      },
      onSelectFile: (f) => selected.push(f),
    })

    // Open
    const trigger = host.querySelector("[data-testid='file-picker-trigger']") as HTMLButtonElement
    trigger.click()
    expect(host.querySelector("[data-testid='file-picker-dropdown']")).not.toBeNull()

    // Simulate file selection from the tree
    selectCallback!("src/bar.ts")

    // Dropdown closed
    expect(host.querySelector("[data-testid='file-picker-dropdown']")).toBeNull()
    // onSelectFile called
    expect(selected).toEqual(["src/bar.ts"])

    cleanup()
  })

  test("dropdown wraps filePicker content in a scroll-inner container", () => {
    const { host, cleanup } = mount({
      file: "src/deeply/nested/path/to/component.tsx",
      filePicker: ({ onSelect }) => {
        const div = document.createElement("div")
        div.setAttribute("data-testid", "mock-tree")
        div.textContent = "tree content"
        return div
      },
      onSelectFile: () => {},
    })

    // Open dropdown
    const trigger = host.querySelector("[data-testid='file-picker-trigger']") as HTMLButtonElement
    trigger.click()

    const dropdown = host.querySelector("[data-testid='file-picker-dropdown']")
    expect(dropdown).not.toBeNull()

    // The dropdown's direct child should be the scroll-inner wrapper
    const scrollInner = dropdown!.querySelector(".session-review-v2-file-picker-scroll-inner")
    expect(scrollInner).not.toBeNull()

    // The filePicker content should be inside the scroll-inner, not directly in the dropdown
    const tree = scrollInner!.querySelector("[data-testid='mock-tree']")
    expect(tree).not.toBeNull()
    expect(tree!.textContent).toBe("tree content")

    cleanup()
  })

  test("dropdown max-width is capped to remaining panel width", async () => {
    Object.defineProperty(window, "innerWidth", { value: 450, configurable: true })

    const { host, cleanup } = mount({
      file: "src/foo.ts",
      filePicker: ({ onSelect }) => {
        const div = document.createElement("div")
        div.setAttribute("data-testid", "mock-tree")
        return div
      },
      onSelectFile: () => {},
    })

    const trigger = host.querySelector("[data-testid='file-picker-trigger']") as HTMLButtonElement
    trigger.click()

    const dropdown = host.querySelector("[data-testid='file-picker-dropdown']") as HTMLElement
    expect(dropdown).not.toBeNull()

    // Simulate the dropdown sitting at x=120 from the panel's left edge
    dropdown.getBoundingClientRect = () => ({
      left: 120, top: 40, right: 520, bottom: 200,
      width: 400, height: 160, x: 120, y: 40,
      toJSON() { return this },
    })

    // Wait for the ref callback's requestAnimationFrame
    await new Promise((r) => setTimeout(r, 50))

    // Should cap at (450 - 120 - 16) = 314px
    expect(dropdown.style.maxWidth).toBe("314px")

    cleanup()
  })

  test("falls back to static filename when no filePicker provided", () => {
    const { host, cleanup } = mount({
      file: "src/foo.ts",
    })

    // No trigger button
    expect(host.querySelector("[data-testid='file-picker-trigger']")).toBeNull()
    // Plain filename span
    const filename = host.querySelector("[data-slot='session-review-v2-file-name']")
    expect(filename).not.toBeNull()
    expect(filename?.textContent).toBe("foo.ts")
    expect(filename?.hasAttribute("data-clickable")).toBe(false)

    cleanup()
  })
})
