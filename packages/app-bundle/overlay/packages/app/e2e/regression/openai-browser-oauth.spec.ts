import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/NewProject"

test("distinguishes browser instructions from a headless confirmation code", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_openai_oauth",
      worktree: directory,
      vcs: "git",
      name: "NewProject",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "free-model": {
              id: "free-model",
              name: "Free Model",
              cost: { input: 0, output: 0 },
              limit: { context: 200_000 },
            },
          },
        },
        { id: "openai", name: "OpenAI", models: {} },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "free-model" },
    },
    integrationMethods: {
      openai: [
        { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
        { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      ],
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileList: (path) =>
      path ? [] : [{ name: "NewProject", path: "NewProject", absolute: directory, type: "directory", ignored: false }],
    findFiles: () => ["NewProject"],
  })
  await page.route("**/provider/openai/oauth/authorize**", (route) => {
    const body = route.request().postDataJSON()
    const headless = typeof body === "object" && body !== null && "method" in body && body.method === 1
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://auth.openai.com/oauth/authorize",
        instructions: headless
          ? "Enter code: 1YZ1-0XWML"
          : "Complete authorization in your browser. This window will close automatically.",
        method: "auto",
      }),
    })
  })
  await page.route("**/provider/openai/oauth/callback**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    await route.abort()
  })
  await page.addInitScript(() => {
    Object.defineProperty(window, "open", {
      value: (url: string | URL) => {
        document.documentElement.dataset.openedExternalUrl = String(url)
        return null
      },
    })
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [] } }))
  })

  await page.goto("/")
  const modelControl = page.locator('[data-action="prompt-model"]')
  await expectAppVisible(modelControl)
  await modelControl.click()
  await page.locator('[data-provider-id="openai"]').click()
  await page.getByRole("button", { name: "ChatGPT Pro/Plus Browser" }).click()

  await expect(page.locator("html")).toHaveAttribute("data-opened-external-url", "https://auth.openai.com/oauth/authorize")
  await expect(page.getByText("Complete authorization in your browser. This window will close automatically.")).toBeVisible()
  await expect(page.getByLabel("Confirmation code")).toHaveCount(0)

  await page.getByRole("button", { name: "Navigate back" }).click()
  await page.getByRole("button", { name: "ChatGPT Pro/Plus Headless" }).click()
  await expect(page.getByLabel("Confirmation code")).toHaveValue("1YZ1-0XWML")
})
