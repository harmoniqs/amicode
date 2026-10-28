// model_picker_config.ts (service) — #1987 (#1979 S4): the model picker's
// deployment config, served to the overlay picker.
//
//   GET /amicode/model-picker → {ok, error, model: {recommended, allowlist?}}
//
// SOURCE: $AMICODE_OPS_DIR/model-picker.json, shape
//   { "model": { "recommended": [{ "model": "provider/id", "role": "default" | "fast" | "strong" | "open-weight" }],
//                "allowlist":   ["provider/id" | "provider/*"] } }
//
// WHY THIS PATH (not OPENCODE_CONFIG_CONTENT → the engine's /config): the
// engine's config schema types `model` as a string ("provider/model") and its
// decode drops unknown keys (ConfigParse.schema, onExcessProperty: "ignore"),
// so `model.recommended` / `model.allowlist` cannot ride the engine config
// without patching the upstream schema. The amicode service is the overlay's
// existing side channel (amicodeGet, per-server auth), it is booted on both
// paths (extension + headless hub runner) through createAmicodeService, and
// fleet clients proxy /amicode/* to the host — one deployment file serves
// every machine. Registered beside the S2 reachability family.
//
// Same service discipline as the sibling families: tolerant reads, bad
// entries dropped (never guessed), FIXED error strings. A missing file is not
// an error: no recommended, no allowlist — nothing is invented.
import { readFileSync } from "node:fs";
import path from "node:path";
import { amicodeOpsDir } from "./connections";

export const MODEL_ROLES = ["default", "fast", "strong", "open-weight"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelPickerConfig {
  recommended: Array<{ model: string; role: ModelRole }>;
  allowlist?: string[];
}

export function modelPickerConfigFile(): string {
  return path.join(amicodeOpsDir(), "model-picker.json");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** "provider/id" or "provider/*": a non-empty provider before the first slash
 *  and a non-empty remainder. */
const isModelRef = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const slash = v.indexOf("/");
  return slash > 0 && slash < v.length - 1;
};

export function readModelPickerConfig(raw: unknown): ModelPickerConfig {
  const model = isObj(raw) && isObj(raw.model) ? raw.model : {};
  const recommended = (Array.isArray(model.recommended) ? model.recommended : []).flatMap((e) =>
    isObj(e) && isModelRef(e.model) && MODEL_ROLES.includes(e.role as ModelRole)
      ? [{ model: e.model, role: e.role as ModelRole }]
      : [],
  );
  if (!Array.isArray(model.allowlist)) return { recommended };
  return { recommended, allowlist: model.allowlist.filter(isModelRef) };
}

/** GET /amicode/model-picker. Never throws. */
export function modelPickerConfigResponse(file: string = modelPickerConfigFile()): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return JSON.stringify({ ok: true, error: null, model: { recommended: [] } });
    return JSON.stringify({ ok: false, error: "config_unreadable: model-picker.json could not be read" });
  }
  try {
    return JSON.stringify({ ok: true, error: null, model: readModelPickerConfig(JSON.parse(text)) });
  } catch {
    return JSON.stringify({ ok: false, error: "config_invalid: model-picker.json is not valid JSON" });
  }
}
