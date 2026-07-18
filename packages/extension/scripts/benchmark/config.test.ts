import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadScenario } from "./config";

function scenarioFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scen-"));
  const f = join(dir, "T.toml");
  writeFileSync(f, body);
  return f;
}

describe("loadScenario v2 multi-stage", () => {
  it("parses flat v1 [[turn]] scenarios unchanged (back-compat)", () => {
    const s = loadScenario(scenarioFile(`id="V1"\n[[turn]]\nsend="hello"\n`));
    expect(s.id).toBe("V1");
    expect(s.turns.length).toBe(1);
    expect(s.stages).toBeUndefined();
  });

  it("parses [[stage]] blocks with turns + an iterate block", () => {
    const s = loadScenario(
      scenarioFile(`
id="H1"
[[stage]]
name="nominal"
[[stage.turn]]
send="design an X gate"
[stage.iterate]
send="fidelity is only 0.6, leakage high — fix it"
max_iterations=2
recovered_when="0\\\\.9"
`),
    );
    expect(s.stages?.length).toBe(1);
    expect(s.stages?.[0].name).toBe("nominal");
    expect(s.stages?.[0].turns[0].send).toContain("X gate");
    expect(s.stages?.[0].iterate?.max_iterations).toBe(2);
    expect(s.turns.length).toBe(0); // stages form leaves flat turns empty
  });

  it("rejects a scenario with BOTH flat turns and stages", () => {
    expect(() =>
      loadScenario(scenarioFile(`id="X"\n[[turn]]\nsend="a"\n[[stage]]\nname="s"\n[[stage.turn]]\nsend="b"\n`)),
    ).toThrow(/both/i);
  });
});
