// amicode#1282: every model ID Amicode ships — baked defaults and the
// onboarding templates written into `config.model` — must resolve against the
// provider catalog the engine resolves IDs against (models.dev, snapshotted in
// test/fixtures/model_catalog.json; refresh with
// scripts/snapshot_model_catalog.mjs). A pin that does not resolve fails every
// prompt that rides it, so a stale ID here is a release bug, not a cosmetic one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROVIDER_MODELS, HARMONIQS_PROVIDER_ID } from "../src/onboarding_panel";
import { MODEL_CLASS_CATALOG } from "../opencode-plugin/model_routing";

type Snapshot = { captured: string; providers: Record<string, { models: string[]; deprecated: string[] }> };

const snapshot: Snapshot = JSON.parse(readFileSync(join(__dirname, "fixtures", "model_catalog.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

/** Split "provider/model" at the FIRST slash (gateway model IDs carry their own slash). */
function split(id: string): { provider: string; model: string } {
  const i = id.indexOf("/");
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/** IDs that do not resolve in the pinned catalog. */
function unresolved(ids: string[]): string[] {
  return ids.filter((id) => {
    const { provider, model } = split(id);
    return !snapshot.providers[provider]?.models.includes(model);
  });
}

describe("shipped model pins resolve against the pinned provider catalog (#1282)", () => {
  it("the catalog snapshot covers every provider a shipped pin names", () => {
    const providers = new Set(
      [
        ...Object.entries(PROVIDER_MODELS)
          .filter(([p]) => p !== HARMONIQS_PROVIDER_ID && p !== "custom")
          .flatMap(([, models]) => models.map((m) => m.id)),
        ...Object.values(MODEL_CLASS_CATALOG).flat(),
      ].map((id) => split(id).provider),
    );
    for (const p of providers) expect(snapshot.providers[p], `catalog snapshot lacks provider ${p}`).toBeDefined();
  });

  it("every onboarding template model ID resolves", () => {
    const ids = Object.entries(PROVIDER_MODELS)
      .filter(([p]) => p !== HARMONIQS_PROVIDER_ID && p !== "custom")
      .flatMap(([, models]) => models.map((m) => m.id));
    expect(unresolved(ids)).toEqual([]);
  });

  it("every onboarding template model belongs to the provider it is offered under", () => {
    // The pick is written as config.model against THAT provider's credential;
    // a model from another provider resolves to a provider the user never authed.
    const mismatched = Object.entries(PROVIDER_MODELS)
      .filter(([p]) => p !== HARMONIQS_PROVIDER_ID && p !== "custom")
      .flatMap(([p, models]) => models.filter((m) => split(m.id).provider !== p).map((m) => `${p}: ${m.id}`));
    expect(mismatched).toEqual([]);
  });

  it("every model-class suggestion candidate resolves", () => {
    expect(unresolved(Object.values(MODEL_CLASS_CATALOG).flat())).toEqual([]);
  });

  it("the baked amicode.distillerModel default resolves", () => {
    const id = pkg.contributes.configuration.properties["amicode.distillerModel"].default as string;
    expect(unresolved([id])).toEqual([]);
  });

  it("the source fallback for amicode.distillerModel matches the manifest default", () => {
    // extension.ts repeats the default as a get<string>() fallback; a drifted
    // copy is an unaudited second pin.
    const src = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");
    const fallbacks = [...src.matchAll(/get<string>\("distillerModel",\s*"([^"]+)"\)/g)].map((m) => m[1]);
    expect(fallbacks.length).toBeGreaterThan(0);
    const manifestDefault = pkg.contributes.configuration.properties["amicode.distillerModel"].default;
    for (const f of fallbacks) expect(f).toBe(manifestDefault);
  });
});
