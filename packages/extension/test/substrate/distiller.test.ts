import { describe, it, expect } from "vitest";
import { buildDistillerConfigContent, type DistillerSetup } from "../../src/substrate/distiller";

const SETUP: DistillerSetup = {
  binary: "/vendor/opencode",
  distillerMdPath: "/ext/DISTILLER.md",
  vaultDir: "/vaults/personal",
  opsDir: "/home/u/.amico/amicode",
  problemsRoot: "/home/u/.amico/problems",
  runsRoot: "/tmp/amicode-runs",
  model: "opencode/big-pickle",
};

describe("buildDistillerConfigContent (spec §4)", () => {
  const cfg = buildDistillerConfigContent(SETUP);
  it("defines ONLY the distiller agent, with the pinned model and DISTILLER.md instructions", () => {
    expect(Object.keys(cfg.agent as object)).toEqual(["distiller"]);
    expect((cfg.agent as any).distiller.model).toBe("opencode/big-pickle");
    expect(cfg.instructions).toEqual(["/ext/DISTILLER.md"]);
  });
  it("grants exactly the read/write surface the spec names — vault amicode subtree, ops, problems, runs — and NO plugin", () => {
    const dirs = Object.keys((cfg.permission as any).external_directory);
    expect(dirs).toContain("/vaults/personal/amicode/**");
    expect(dirs).toContain("/vaults/personal/.git/**"); // pathspec-scoped commits need index access
    expect(dirs).toContain("/home/u/.amico/amicode/**");
    expect(dirs).toContain("/home/u/.amico/problems/**");
    expect(dirs).toContain("/tmp/amicode-runs/**");
    expect(cfg).not.toHaveProperty("plugin"); // native tools only — no amicode_* bookkeeping in the distiller
    expect(cfg).not.toHaveProperty("skills");
  });
});
