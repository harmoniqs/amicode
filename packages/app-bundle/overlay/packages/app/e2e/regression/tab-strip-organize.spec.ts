import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { currentSession } from "../utils/mock-server"

// amicode#2154: the tab strip stays readable and organisable with many tabs —
// readable minimum widths + an all-tabs list, a tab context menu, pinned
// tabs, and spawned sessions grouped after their parent.

const server = "http://127.0.0.1:4096"
const directory = "C:/tab-project"

const titles = [
  "Project inference review",
  "Aaron's to-do list",
  "Passaggissimo.jl #43 handoffs",
  "Atoms Slack follow-up",
  "Reading Aaron's Slack papers",
  "Opus 5.5 ENOTFOUND Bedrock error",
  "Reviewing and merging open PRs",
  "Meeting-vault summary",
  "Open work across sessions",
  "Tab navigation with many tabs",
  "Spawned: fidelity sweep",
  "Spawned: knot ladder",
]
const sessions = titles.map((title, index) => session(`ses_org_${String(index).padStart(2, "0")}`, title))
const parent = sessions[2]
const children = [sessions[10], sessions[11]]
for (const child of children) child.metadata = { spawned_by: parent.id, spawned_depth: 1 }

const href = (id: string) => `/server/${base64Encode(server)}/session/${id}`
const slot = (page: Page, id: string) => page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(id)}"])`)
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

async function open(page: Page, tabs: Array<Record<string, unknown>>, width = 1100) {
  await page.setViewportSize({ width, height: 700 })
  await mockServer(page)
  await page.addInitScript(
    ({ tabs }) => {
      // Seed once per test: the init script also runs on reload, which must
      // see what the app persisted, not the seed.
      if (sessionStorage.getItem("tab-org-seeded")) return
      sessionStorage.setItem("tab-org-seeded", "1")
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { tabs },
  )
  await page.goto(href(sessions[0].id))
  await expect(slot(page, sessions[0].id)).toBeVisible()
}

const allTabs = (pinned: string[] = []) =>
  sessions.map((item) => ({
    type: "session",
    server,
    sessionId: item.id,
    ...(pinned.includes(item.id) ? { pinned: true } : {}),
  }))

test("tabs keep a readable width and the strip offers an all-tabs list once they overflow", async ({ page }) => {
  await open(page, allTabs())
  await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(sessions.length)

  // No tab is squeezed below the 160px floor; the active tab keeps 224px.
  const widths = await page
    .locator("[data-titlebar-tab-slot]")
    .evaluateAll((slots) => slots.map((el) => el.getBoundingClientRect().width))
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(159.5)
  const active = await slot(page, sessions[0].id).boundingBox()
  expect(active?.width).toBeGreaterThanOrEqual(223.5)

  // Twelve tabs at 160px+ cannot fit in 1100px: the list appears.
  const trigger = page.getByRole("button", { name: "All tabs" })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const list = page.locator('[data-slot="titlebar-tab-list"]')
  await expect(list).toBeVisible()
  await expect(list.locator("[data-tab-list-key]")).toHaveCount(sessions.length)

  await expect(page.getByRole("textbox", { name: "Search open tabs" })).toBeFocused()
  await page.getByRole("textbox", { name: "Search open tabs" }).fill("bedrock")
  await expect(list.locator("[data-tab-list-key]")).toHaveCount(1)
  await page.keyboard.press("Enter")

  const target = sessions[5]
  await expect(page).toHaveURL(new RegExp(`${escape(href(target.id))}$`))
  await expect(list).toBeHidden()
  // The chosen tab is scrolled into view in the strip.
  await expect(slot(page, target.id)).toBeInViewport()
})

test("spawned sessions sit right after their parent, marked as one group", async ({ page }) => {
  await open(page, allTabs())
  const order = page.locator("[data-titlebar-tab-slot]")
  await expect(slot(page, parent.id)).toHaveAttribute("data-group-edge", "start")
  await expect(slot(page, children[0].id)).toHaveAttribute("data-group-edge", "middle")
  await expect(slot(page, children[1].id)).toHaveAttribute("data-group-edge", "end")

  const keys = await order.evaluateAll((slots) => slots.map((el) => el.querySelector("a")?.getAttribute("href")))
  const at = (id: string) => keys.indexOf(href(id))
  expect(at(children[0].id)).toBe(at(parent.id) + 1)
  expect(at(children[1].id)).toBe(at(parent.id) + 2)
})

test("pinning from the tab menu moves the tab to the left and compacts it", async ({ page }) => {
  await open(page, allTabs())
  const target = sessions[4]
  await slot(page, target.id).locator("a[data-titlebar-tab-link]").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Pin tab" }).click()

  const first = page.locator("[data-titlebar-tab-slot]").first()
  await expect(first).toHaveAttribute("data-pinned", "true")
  await expect(first.locator(`a[href="${href(target.id)}"]`)).toHaveCount(1)
  await expect(first.locator("[data-titlebar-tab-title]")).toBeHidden()
  await expect(first.locator('[data-slot="tab-close"]')).toHaveCount(0)
  const box = await first.boundingBox()
  expect(box?.width).toBeLessThan(40)

  // Survives a reload.
  await page.reload()
  await expect(page.locator("[data-titlebar-tab-slot]").first()).toHaveAttribute("data-pinned", "true")
})

test("close other tabs keeps pinned tabs, and the closed tabs can be reopened", async ({ page }) => {
  const pinned = sessions[7]
  await open(page, allTabs([pinned.id]))
  const anchor = sessions[0]
  await slot(page, anchor.id).locator("a[data-titlebar-tab-link]").click({ button: "right" })
  // Twelve tabs, minus the anchor and the pinned one.
  await page.getByRole("menuitem", { name: "Close other tabs (10)" }).click()

  await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(2)
  await expect(slot(page, pinned.id)).toBeVisible()
  await expect(slot(page, anchor.id)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`${escape(href(anchor.id))}$`))

  // mod+shift+t (the Desktop Chrome device reports Windows, so mod = Control)
  await page.keyboard.press("Control+Shift+t")
  await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(3)
})

test("close group closes a parent and the sessions it spawned", async ({ page }) => {
  await open(page, allTabs())
  await expect(slot(page, children[1].id)).toHaveAttribute("data-group-edge", "end")
  await slot(page, children[0].id).locator("a[data-titlebar-tab-link]").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Close group (3)" }).click()

  await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(sessions.length - 3)
  for (const id of [parent.id, ...children.map((child) => child.id)]) await expect(slot(page, id)).toHaveCount(0)
})

test("the all-tabs list opens from its keybind even when every tab fits", async ({ page }) => {
  await open(page, allTabs().slice(0, 3), 1400)
  await expect(page.getByRole("button", { name: "All tabs" })).toHaveCount(0)
  // mod+alt+a (the Desktop Chrome device reports Windows, so mod = Control)
  await page.keyboard.press("Control+Alt+a")
  const list = page.locator('[data-slot="titlebar-tab-list"]')
  await expect(list.locator("[data-tab-list-key]")).toHaveCount(3)
  await expect(page.getByRole("textbox", { name: "Search open tabs" })).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`${escape(href(sessions[1].id))}$`))
})

test("right-clicking a tab opens the tab menu, not the titlebar customize menu", async ({ page }) => {
  await open(page, allTabs().slice(0, 3))
  await slot(page, sessions[1].id).locator("a[data-titlebar-tab-link]").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Close tab", exact: true })).toBeVisible()
  await expect(page.locator(".titlebar-context-menu")).toHaveCount(0)
})

type MockSession = ReturnType<typeof session>

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID: "project-tabs",
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
    metadata: undefined as Record<string, unknown> | undefined,
  }
}

async function mockServer(page: Page) {
  const byPath = (pathname: string, prefix: string) =>
    sessions.find((item: MockSession) => pathname === `${prefix}${item.id}`)
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== server) return route.fallback()
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    if (url.pathname === "/global/health") return json(route, { healthy: true })
    if (url.pathname === "/api/session") return json(route, { data: sessions.map(currentSession), cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    const current = byPath(url.pathname, "/api/session/")
    if (current) return json(route, { data: currentSession(current) })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`))
      return json(route, { data: [], cursor: {} })
    // The legacy endpoint carries metadata (the spawn stamp).
    const legacy = byPath(url.pathname, "/session/")
    if (legacy) return json(route, legacy)
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (["/skill", "/command", "/lsp", "/formatter", "/permission", "/question", "/vcs/diff"].includes(url.pathname))
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider")
      return json(route, { all: [], connected: [], default: { providerID: "", modelID: "" } })
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = { id: "project-tabs", worktree: directory, vcs: "git", time: { created: 1, updated: 1 }, sandboxes: [] }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path" || url.pathname === "/api/path")
      return json(route, { state: directory, config: directory, worktree: directory, directory, home: directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    return json(route, {})
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
