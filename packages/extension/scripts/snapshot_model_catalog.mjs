#!/usr/bin/env node
// amicode#1282: snapshot the provider catalog the engine resolves model IDs
// against (models.dev — baked into the binary at build time, refreshed at
// runtime) into test/fixtures/model_catalog.json, trimmed to the providers
// Amicode ships model IDs for. test/shipped_model_pins.test.ts checks every
// baked default / onboarding template ID against this snapshot.
//
//   node packages/extension/scripts/snapshot_model_catalog.mjs [catalog.json | https://models.dev/api.json]
//
// Default source: the engine's own cache, ~/.cache/opencode/models.json.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDERS = [
  "opencode",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "vercel",
  "amazon-bedrock",
  "github-copilot",
  "zai",
];

const src = process.argv[2] ?? join(homedir(), ".cache", "opencode", "models.json");
const catalog = src.startsWith("http")
  ? await (await fetch(src)).json()
  : JSON.parse(readFileSync(src, "utf8"));

const providers = {};
for (const id of PROVIDERS) {
  const models = catalog[id]?.models;
  if (!models) throw new Error(`provider "${id}" missing from ${src}`);
  const ids = Object.keys(models).sort();
  providers[id] = {
    models: ids,
    deprecated: ids.filter((m) => models[m].status === "deprecated"),
  };
}

const out = join(import.meta.dirname, "..", "test", "fixtures", "model_catalog.json");
const snapshot = {
  _source: "models.dev provider catalog (what the engine resolves provider/model IDs against)",
  _refresh: "node packages/extension/scripts/snapshot_model_catalog.mjs",
  captured: new Date().toISOString().slice(0, 10),
  providers,
};
writeFileSync(out, JSON.stringify(snapshot, null, 1) + "\n");
console.log(`wrote ${out} (${PROVIDERS.length} providers)`);
