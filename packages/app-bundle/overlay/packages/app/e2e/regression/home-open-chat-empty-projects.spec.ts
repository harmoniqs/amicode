import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

// Regression: on a fresh profile (no tracked projects in localStorage) the
// home "Open chat" CTA dead-ended silently — startWithPrompt fell through to
// openNewSession(), which needs the same newSessionProject() that just came
// back empty. It must instead fall back to the server's own working
// directory (GET /path → .directory) and start a draft there, tracking the
// directory as a project so the rest of the home page works from then on.
test("home 'Open chat' falls back to the server cwd on a fresh profile", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: [],
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })

  // Deliberately NO localStorage seed — an empty tracked-project list is the
  // regression condition (contrast: session-list-path-loading.spec.ts seeds it).
  await page.goto("/")
  // exact: true — the whole Meet-Amico card is also a button whose accessible
  // name contains "Open chat"; we want the CTA inside it.
  await page.getByRole("button", { name: "Open chat", exact: true }).click()

  // Navigates to a new-session draft instead of doing nothing.
  await expect(page).toHaveURL(/\/new-session\?draftId=/)

  // And the server cwd is now a tracked project (the self-healing part).
  const persisted = await page.evaluate(() => localStorage.getItem("opencode.global.dat:server") ?? "")
  expect(persisted).toContain(fixture.directory)
})
