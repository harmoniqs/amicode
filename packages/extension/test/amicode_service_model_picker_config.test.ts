// #1987 (#1979 S4): the model picker's deployment config — `model.recommended`
// + `model.allowlist` read from $AMICODE_OPS_DIR/model-picker.json and served
// to the overlay picker at GET /amicode/model-picker (same family as the S2
// reachability routes, so both boot paths — extension + hub runner — wire it).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelPickerConfigFile, modelPickerConfigResponse, readWatchGlobs } from "../src/amicode_service/model_picker_config";

const tmp = () => mkdtempSync(join(tmpdir(), "amc-1987-"));

describe("modelPickerConfigResponse", () => {
  it("no file → ok with no recommended and no allowlist (nothing invented)", () => {
    const body = JSON.parse(modelPickerConfigResponse(join(tmp(), "missing.json")));
    expect(body).toEqual({ ok: true, error: null, model: { recommended: [] } });
  });

  it("a well-formed file is served (provider/id refs, roles, allowlist incl. provider/*)", () => {
    const file = join(tmp(), "model-picker.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: {
          recommended: [
            { model: "anthropic/claude-sonnet", role: "default" },
            { model: "groq/llama", role: "fast" },
          ],
          allowlist: ["anthropic/*", "groq/llama"],
        },
      }),
    );
    expect(JSON.parse(modelPickerConfigResponse(file))).toEqual({
      ok: true,
      error: null,
      model: {
        recommended: [
          { model: "anthropic/claude-sonnet", role: "default" },
          { model: "groq/llama", role: "fast" },
        ],
        allowlist: ["anthropic/*", "groq/llama"],
      },
    });
  });

  it("bad entries are dropped (unknown role, no provider/ prefix, non-string)", () => {
    const file = join(tmp(), "model-picker.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: {
          recommended: [{ model: "a/x", role: "turbo" }, { model: "noslash", role: "fast" }, { model: "a/y", role: "strong" }, 5],
          allowlist: ["a/*", 3, "", "noslash"],
        },
      }),
    );
    expect(JSON.parse(modelPickerConfigResponse(file)).model).toEqual({
      recommended: [{ model: "a/y", role: "strong" }],
      allowlist: ["a/*"],
    });
  });

  it("#2000: model.watch globs are parsed, trimmed, and bad entries dropped; absent → no key", () => {
    const file = join(tmp(), "model-picker.json");
    writeFileSync(file, JSON.stringify({ model: { watch: ["gemini-4-carbon*", " kimi-k3.1* ", "", 7, null] } }));
    expect(JSON.parse(modelPickerConfigResponse(file)).model).toEqual({
      recommended: [],
      watch: ["gemini-4-carbon*", "kimi-k3.1*"],
    });
    expect(readWatchGlobs(file)).toEqual(["gemini-4-carbon*", "kimi-k3.1*"]);
    writeFileSync(file, JSON.stringify({ model: { recommended: [] } }));
    expect(JSON.parse(modelPickerConfigResponse(file)).model).toEqual({ recommended: [] });
    expect(readWatchGlobs(file)).toEqual([]);
    expect(readWatchGlobs(join(tmp(), "missing.json"))).toEqual([]);
  });

  it("malformed JSON → ok:false with a fixed error string", () => {
    const file = join(tmp(), "model-picker.json");
    writeFileSync(file, "{ nope");
    expect(JSON.parse(modelPickerConfigResponse(file))).toEqual({
      ok: false,
      error: "config_invalid: model-picker.json is not valid JSON",
    });
  });

  describe("default file location", () => {
    const prev = process.env.AMICODE_OPS_DIR;
    beforeEach(() => {
      process.env.AMICODE_OPS_DIR = tmp();
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.AMICODE_OPS_DIR;
      else process.env.AMICODE_OPS_DIR = prev;
    });
    it("lives under $AMICODE_OPS_DIR", () => {
      expect(modelPickerConfigFile()).toBe(join(process.env.AMICODE_OPS_DIR!, "model-picker.json"));
    });
  });
});

describe("GET /amicode/model-picker on the real service", () => {
  const prev = process.env.AMICODE_OPS_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = prev;
  });

  it("serves the ops-dir file", async () => {
    const ops = tmp();
    process.env.AMICODE_OPS_DIR = ops;
    writeFileSync(
      join(ops, "model-picker.json"),
      JSON.stringify({ model: { recommended: [{ model: "a/x", role: "default" }], allowlist: ["a/*"] } }),
    );
    const { createAmicodeService } = await import("../src/amicode_service");
    const service = createAmicodeService({});
    const url = await service.start();
    try {
      const res = await fetch(new URL("/amicode/model-picker", url), { headers: { Authorization: service.authHeader } });
      expect(res.status).toBe(200);
      expect(JSON.parse(await res.text())).toEqual({
        ok: true,
        error: null,
        model: { recommended: [{ model: "a/x", role: "default" }], allowlist: ["a/*"] },
      });
    } finally {
      await service.stop();
    }
  });
});
