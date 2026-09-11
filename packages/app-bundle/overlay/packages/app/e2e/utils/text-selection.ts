import type { Locator, Page } from "@playwright/test"

export async function dragSelectText(page: Page, text: Locator) {
  const box = await text.boundingBox()
  if (!box) throw new Error("Text must be measurable before selection")

  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 0.5, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
}
