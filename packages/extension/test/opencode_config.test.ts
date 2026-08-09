import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import {
  prepareOpencodeProject,
  resolveJuliaProject,
  buildOpencodeConfigContent,
  resolveModelPin,
  profileHasIdentity,
  routingSection,
} from "../src/opencode_config";

function fakeExtRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "extroot-"));
  writeFileSync(join(root, "AGENTS.md"), "# A\nproject: {{JULIA_PROJECT}}\ntemplate: {{TEMPLATE_PATH}}\n");
  mkdirSync(join(root, "templates"));
  writeFileSync(join(root, "templates", "solve_template.jl"), "# template\n");
  return root;
}

describe("resolveJuliaProject", () => {
  const def = join(homedir(), ".amico", "julia");
  it("defaults to ~/.amico/julia when empty or whitespace", () => {
    expect(resolveJuliaProject("")).toBe(def);
    expect(resolveJuliaProject("   ")).toBe(def);
  });
  it("uses a configured value, trimmed", () => {
    expect(resolveJuliaProject("/opt/piccolo")).toBe("/opt/piccolo");
    expect(resolveJuliaProject("  /opt/p  ")).toBe("/opt/p");
  });
  it("expands a leading ~ (parity with resolveRunsRoot)", () => {
    expect(resolveJuliaProject("~")).toBe(homedir());
    expect(resolveJuliaProject("~/foo/bar")).toBe(join(homedir(), "foo", "bar"));
  });
});

describe("buildOpencodeConfigContent", () => {
  const TPL = "/ext/templates/solve_template.jl";
  it("emits valid JSON whose instructions points at the (absolute) agents file", () => {
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(cfg.instructions).toEqual(["/abs/AGENTS.md"]);
  });
  it("scopes external_directory to the template + scratch + runs roots (least privilege), drops webfetch", () => {
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    const ed = cfg.permission.external_directory;
    expect(typeof ed).toBe("object"); // path-scoped, NOT a blanket "allow"
    expect(ed[TPL]).toBe("allow"); // the template file the agent reads
    expect(ed["/ext/templates/**"]).toBe("allow"); // its dir (belt-and-suspenders)
    expect(ed["/tmp/amicode-work/**"]).toBe("allow"); // scratch it writes solve.jl into
    expect(ed["/private/tmp/amicode-work/**"]).toBe("allow"); // macOS: /tmp → /private/tmp
    // The runs root: AGENTS.md tells the agent to read FINISHED/result.toml for
    // results and run.log for tracebacks — without this grant every such read is
    // an external_directory "ask" prompt (one per solve, worse on failures).
    expect(ed["/home/u/.amico/runs/default/**"]).toBe("allow");
    expect(cfg.permission.bash).toBe("allow"); // runs amico-run (compound launch)
    expect(cfg.permission.edit).toBe("allow"); // fills the FILL-IN block
    expect(cfg.permission.webfetch).toBeUndefined(); // unused by the solve flow — dropped
  });
  it("registers the amicode_* plugin by ABSOLUTE default path — and the file actually exists", () => {
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(Array.isArray(cfg.plugin)).toBe(true);
    expect(cfg.plugin).toHaveLength(1);
    expect(isAbsolute(cfg.plugin[0])).toBe(true); // opencode imports it by abs path
    expect(cfg.plugin[0].endsWith(join("opencode-plugin", "amicode_tools.ts"))).toBe(true);
    expect(existsSync(cfg.plugin[0])).toBe(true); // __dirname default resolves to the real file
    expect(existsSync(join(cfg.plugin[0], "..", "entities.ts"))).toBe(true); // its relative import target too
  });
  it("honors an explicit pluginPath (the follow-up extension.ts wiring)", () => {
    const cfg = JSON.parse(
      buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default", "/elsewhere/amicode_tools.ts"),
    );
    expect(cfg.plugin).toEqual(["/elsewhere/amicode_tools.ts"]);
  });
  it("registers skills.paths only when a stage dir is given (opencode-native skills)", () => {
    const without = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(without.skills).toBeUndefined(); // no stage dir → no skills key at all
    const withStage = JSON.parse(
      buildOpencodeConfigContent(
        "/abs/AGENTS.md",
        TPL,
        "/home/u/.amico/runs/default",
        undefined,
        undefined,
        [],
        "/tmp/proj/skills",
      ),
    );
    expect(withStage.skills).toEqual({ paths: ["/tmp/proj/skills"] }); // absolute per-session dir (guarded set), never a library root
  });
  it("retires the pulse-designer agent shell — the picker is plan/build only (#389)", () => {
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(cfg.agent ?? {}).toEqual({}); // no custom agents: the interview lives in AGENTS.md, agent-agnostic
  });
  it("pins default_agent to plan (plan-first posture for new sessions)", () => {
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(cfg.default_agent).toBe("plan"); // read-only open; the user switches to build to execute
  });
  it("pins default_agent to plan (plan-first posture for new sessions)", () => {
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(cfg.default_agent).toBe("plan"); // read-only open; the user switches to pulse-designer/build to execute
  });
  it("grants external_directory on the problems root (default + $AMICODE_PROBLEMS_DIR override)", () => {
    const defGrant = join(homedir(), ".amico", "problems") + "/**";
    const cfg = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
    expect(cfg.permission.external_directory[defGrant]).toBe("allow");
    const prev = process.env.AMICODE_PROBLEMS_DIR;
    process.env.AMICODE_PROBLEMS_DIR = "/custom/problems";
    try {
      const cfg2 = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default"));
      expect(cfg2.permission.external_directory["/custom/problems/**"]).toBe("allow"); // grant follows the plugin
    } finally {
      if (prev === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
      else process.env.AMICODE_PROBLEMS_DIR = prev;
    }
  });
  it("grants external_directory <path>/** for EVERY Armonia mount, retaining the personal-vault amicode grant", () => {
    const mounts = [
      { name: "me", kind: "personal", path: "/v/me", writable: true },
      { name: "team", kind: "team", path: "/v/team", writable: false },
    ];
    const cfg = JSON.parse(
      buildOpencodeConfigContent(
        "/abs/AGENTS.md",
        TPL,
        "/home/u/.amico/runs/default",
        undefined,
        undefined,
        [],
        "",
        "/v/me",
        mounts,
      ),
    );
    const ed = cfg.permission.external_directory;
    expect(ed["/v/me/**"]).toBe("allow"); // personal mount read grant
    // a read-only mount STILL gets a read grant — the permission surface has no
    // r/w split; write discipline stays distiller-side (documented posture).
    expect(ed["/v/team/**"]).toBe("allow");
    expect(ed["/v/me/amicode/**"]).toBe("allow"); // existing personal-vault grant retained
  });
  it("no mounts → no per-mount grants (only the personal amicode grant when a vaultDir is given)", () => {
    const cfg = JSON.parse(
      buildOpencodeConfigContent(
        "/abs/AGENTS.md",
        TPL,
        "/home/u/.amico/runs/default",
        undefined,
        undefined,
        [],
        "",
        "/v/me",
      ),
    );
    const ed = cfg.permission.external_directory;
    expect(ed["/v/me/**"]).toBeUndefined(); // no mount list → no whole-mount grant
    expect(ed["/v/me/amicode/**"]).toBe("allow");
  });
  it("never embeds a credential in the config content (D11 no-store/no-inject regression guard)", () => {
    // amico owns no secret: the config it writes into OPENCODE_CONFIG_CONTENT must
    // never carry a provider key, even when one is present in the environment.
    // Guards against a future edit that starts sourcing a key into the config.
    const SENTINEL = "sk-ant-LEAK5ENTINEL0000000000000000";
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = SENTINEL;
    try {
      const content = buildOpencodeConfigContent("/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default");
      expect(content).not.toContain(SENTINEL); // no env-sourced key leaks in
      expect(content).not.toMatch(/sk-[A-Za-z0-9-]{16,}/); // no key-shaped string at all
      expect(content.toLowerCase()).not.toMatch(/"(apikey|api_key|authorization|bearer|token)"\s*:/);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
  it("sets experimental.openTelemetry === true IFF the telemetry gate is open (span generation)", () => {
    // opencode gates AI-SDK span generation on cfg.experimental?.openTelemetry;
    // the OTLP endpoint env only arms the exporter, so this flag is what makes
    // opencode actually EMIT spans. It must track the same gate as the exporter.
    const args = ["/abs/AGENTS.md", TPL, "/home/u/.amico/runs/default", undefined, undefined, [], "", "", []] as const;
    // default (gate arg omitted) → no flag → a user's own experimental config is untouched
    expect(JSON.parse(buildOpencodeConfigContent(...args)).experimental).toBeUndefined();
    // gate SHUT → omitted (not forced false, so we never clobber the user's own value)
    expect(JSON.parse(buildOpencodeConfigContent(...args, undefined, false)).experimental).toBeUndefined();
    // gate OPEN → span generation on
    expect(JSON.parse(buildOpencodeConfigContent(...args, undefined, true)).experimental).toEqual({
      openTelemetry: true,
    });
  });
});

// Integration (#25): boots the REAL opencode binary (`opencode debug config`
// resolves + dumps the merged config, equivalent to GET /config) with the REAL
// buildOpencodeConfigContent as OPENCODE_CONFIG_CONTENT, and asserts the whole
// injection + merge the extension relies on at spawn:
//   - the injected `instructions` (the AGENTS.md path) is present — this is the
//     regression the old boot_smoke false-green missed: boot_smoke.mjs boots
//     WITHOUT OPENCODE_CONFIG_CONTENT, so it stayed green even if the instruction
//     injection were removed. This test reds instead.
//   - the user's global `model` survives the deep-merge (opencode picks the
//     provider from it — the merge must not clobber it);
//   - the user's global `permission` keys survive AND our injected permission key
//     is added (deep-merge, not shallow-replace — folds in the #22 check).
// Uses the real builder (no transcribed copy → no drift; boot_smoke.mjs can't
// import the TS builder, which is why this lives here). Skipped when the vendored
// binary isn't present (e.g. minimal CI before `fetch:opencode`).
const OC_BIN = join(__dirname, "..", "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
describe.skipIf(!existsSync(OC_BIN))("opencode config injection + merge (1.17.3)", () => {
  it("injects instructions/permission AND preserves the user global model + permission", () => {
    const home = mkdtempSync(join(tmpdir(), "ochome-"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    // A user global config with a distinctive model + permission key — both must
    // survive the deep-merge under OPENCODE_CONFIG_CONTENT.
    writeFileSync(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "anthropic/claude-sonnet-4-6", permission: { doom_loop: "deny" } }),
    );
    const agentsPath = join(home, "AGENTS.md"); // the exact file our `instructions` must point at
    writeFileSync(agentsPath, "# amico\n");
    const out = execFileSync(OC_BIN, ["debug", "config"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(
          agentsPath,
          "/ext/templates/solve_template.jl",
          join(home, ".amico", "runs", "default"),
        ),
      },
    });
    const cfg = JSON.parse(out);
    // our injection landed (the false-green boot_smoke couldn't catch):
    expect(cfg.instructions).toContain(agentsPath); // the AGENTS.md instruction injection
    expect(typeof cfg.permission.external_directory).toBe("object"); // our injected permission key
    // the runs-root grant survives the real deep-merge — the agent's post-solve
    // FINISHED/result.toml/run.log read-backs must not "ask" on every run:
    expect(cfg.permission.external_directory[join(home, ".amico", "runs", "default") + "/**"]).toBe("allow");
    // the user's global config SURVIVED the deep-merge:
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-6"); // provider/model preserved (Q129 needs this)
    expect(cfg.permission.doom_loop).toBe("deny"); // user permission key preserved (#22)
    // L0 registration survived resolution against the REAL binary.
    // NOTE: `debug config` IMPORTS listed plugins before printing JSON to stdout
    // (verified on 1.17.3) — so JSON.parse(out) succeeding above doubles as a
    // regression guard that amicode_tools.ts loads cleanly AND never writes to
    // stdout at module scope (its load line must stay on stderr).
    expect(cfg.plugin).toHaveLength(1);
    expect(cfg.plugin[0].endsWith(join("opencode-plugin", "amicode_tools.ts"))).toBe(true);
    // #389: the pulse-designer agent shell is retired; default is plan.
    expect(cfg.agent?.["pulse-designer"]).toBeUndefined();
    expect(cfg.default_agent).toBe("plan");
  });
});

describe("prepareOpencodeProject", () => {
  it("substitutes the julia project AND the absolute template path, leaving no placeholders", () => {
    const ext = fakeExtRoot();
    const templateSrc = join(ext, "templates", "solve_template.jl");
    const p = prepareOpencodeProject({
      agentsSrc: join(ext, "AGENTS.md"),
      templateSrc,
      juliaProject: "/opt/piccolo",
      vaultDir: "",
    });
    const agents = readFileSync(p.agentsPath, "utf8");
    expect(agents).toContain("/opt/piccolo");
    expect(agents).toContain(templateSrc); // {{TEMPLATE_PATH}} → the absolute bundled template
    expect(agents).not.toMatch(/\{\{.*?\}\}/); // no residual placeholders
    expect(p.templatePath).toBe(templateSrc); // points at the bundled source, not a copy
  });
  it("does NOT copy the template or write a vestigial .opencode/opencode.json into the session dir", () => {
    const ext = fakeExtRoot();
    const p = prepareOpencodeProject({
      agentsSrc: join(ext, "AGENTS.md"),
      templateSrc: join(ext, "templates", "solve_template.jl"),
      juliaProject: "/opt/piccolo",
      vaultDir: "",
    });
    expect(existsSync(join(p.projectDir, "solve_template.jl"))).toBe(false);
    expect(existsSync(join(p.projectDir, ".opencode", "opencode.json"))).toBe(false);
  });
  it("reuses an explicit projectDir across activations (creates it, re-prepare is idempotent)", () => {
    const ext = fakeExtRoot();
    const stable = join(mkdtempSync(join(tmpdir(), "storage-")), "opencode-project"); // does not exist yet
    const opts = {
      agentsSrc: join(ext, "AGENTS.md"),
      templateSrc: join(ext, "templates", "solve_template.jl"),
      juliaProject: "/opt/piccolo",
      vaultDir: "",
      projectDir: stable,
    };
    const first = prepareOpencodeProject(opts);
    expect(first.projectDir).toBe(stable); // no mkdtemp — the dir the app persists stays valid
    const second = prepareOpencodeProject(opts); // second activation: same dir, no throw
    expect(second.projectDir).toBe(stable);
    expect(readFileSync(second.agentsPath, "utf8")).toContain("/opt/piccolo");
  });
});

describe("routingSection (Δ10 #63 — per-solve routing guidance splice)", () => {
  // Isolate BOTH seams the section reads: the solver-mode file ($AMICODE_OPS_DIR)
  // and the connections status cache ($AMICODE_CONNECTIONS_FILE). No network, no
  // real HOME.
  function withSession(mode: "piccolo" | "hp", conn: unknown | undefined, run: () => void) {
    const opsDir = mkdtempSync(join(tmpdir(), "ops-"));
    writeFileSync(join(opsDir, "solver-mode.json"), JSON.stringify({ mode, status: "ready" }));
    const connFile = join(mkdtempSync(join(tmpdir(), "conn-")), "connections.json");
    if (conn !== undefined) writeFileSync(connFile, JSON.stringify(conn));
    const prevOps = process.env.AMICODE_OPS_DIR;
    const prevConn = process.env.AMICODE_CONNECTIONS_FILE;
    process.env.AMICODE_OPS_DIR = opsDir;
    process.env.AMICODE_CONNECTIONS_FILE = connFile;
    try {
      run();
    } finally {
      if (prevOps === undefined) delete process.env.AMICODE_OPS_DIR;
      else process.env.AMICODE_OPS_DIR = prevOps;
      if (prevConn === undefined) delete process.env.AMICODE_CONNECTIONS_FILE;
      else process.env.AMICODE_CONNECTIONS_FILE = prevConn;
    }
  }

  it("hp mode + connected → renders the routing offer with the estimate-driven confirm", () => {
    withSession("hp", { "company-compute": { state: "connected", identity: "kate@harmoniqs.co" } }, () => {
      const s = routingSection();
      expect(s).toMatch(/## Routing/);
      expect(s).toMatch(/amico-run estimate/);
      expect(s).toMatch(/executor.*"remote"/);
      expect(s).toMatch(/connected as kate@harmoniqs\.co/);
    });
  });

  it("hp mode but disconnected → no routing offer (connection gate)", () => {
    withSession("hp", { "company-compute": { state: "needs-key" } }, () => {
      expect(routingSection()).toBe("");
    });
  });

  it("piccolo mode (the default) → no routing offer even if connected", () => {
    withSession("piccolo", { "company-compute": { state: "connected" } }, () => {
      expect(routingSection()).toBe("");
    });
  });

  it("no connections cache at all → no routing offer, no throw", () => {
    withSession("hp", undefined, () => {
      expect(routingSection()).toBe("");
    });
  });
});

describe("resolveModelPin (no forced fallback)", () => {
  it("never forces a model pin — the default comes from amicode.defaultModel or opencode's own resolution", () => {
    // A hardcoded fallback in config.model outranked the user's recent pick
    // (configuredModel ?? recentModel ?? default), overriding their choice.
    expect(resolveModelPin()).toBeUndefined();
  });
});

describe("profileHasIdentity (wizard → overture gate)", () => {
  it("true only when an identity field is a non-empty string", () => {
    const dir = mkdtempSync(join(tmpdir(), "prof-"));
    const fp = join(dir, "profile.json");
    expect(profileHasIdentity(fp)).toBe(false); // absent
    writeFileSync(fp, JSON.stringify({}));
    expect(profileHasIdentity(fp)).toBe(false); // empty
    writeFileSync(fp, JSON.stringify({ affiliation: "  " }));
    expect(profileHasIdentity(fp)).toBe(false); // whitespace
    writeFileSync(fp, JSON.stringify({ affiliation: "NYU" }));
    expect(profileHasIdentity(fp)).toBe(true);
    writeFileSync(fp, "not json");
    expect(profileHasIdentity(fp)).toBe(false); // corrupt → safe default (onboard)
  });
});
