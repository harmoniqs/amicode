import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const KEY = "toast.session.compact.failed.description"
const i18nDir = dirname(fileURLToPath(import.meta.url))
const commandSource = join(i18nDir, "..", "pages", "session", "use-session-commands.tsx")
const locales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "en",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "th",
  "tr",
  "uk",
  "zh",
  "zht",
]

describe("compaction failure toast", () => {
  test("resolves its description through the language translator", () => {
    const source = readFileSync(commandSource, "utf8")

    expect(source).toContain(`description: language.t("${KEY}"),`)
  })

  test("has a non-empty translation in every supported locale", async () => {
    for (const locale of locales) {
      const module: unknown = await import(`./${locale}`)
      if (typeof module !== "object" || module === null || !("dict" in module)) {
        throw new Error(`Invalid ${locale} dictionary module`)
      }
      const dict = (module as { dict: Record<string, string> }).dict
      expect(dict[KEY], `${locale} is missing ${KEY}`).toSatisfy(
        (value) => typeof value === "string" && value.length > 0,
      )
    }
  })
})
