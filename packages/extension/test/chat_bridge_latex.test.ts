import { describe, it, expect } from "vitest";
import { classifyLatexmkProbe, runLatexmk, type BridgeIo, type LatexExec } from "../src/chat_bridge";

// #1414 (CodeRabbit, Minor): the latexmk availability probe cached `!err` on ANY
// error, so a transient probe failure (timeout, a broken -version exit) disabled
// LaTeX for the whole session. Only a definitive "not installed" (ENOENT) may
// cache false; a successful probe caches true; anything else stays uncached and
// is treated as available so the real compile reports its own result.
describe("classifyLatexmkProbe", () => {
  it("treats a successful probe as available and caches it", () => {
    expect(classifyLatexmkProbe(null)).toEqual({ available: true, cache: true });
  });

  it("caches false only for ENOENT (latexmk genuinely not installed)", () => {
    expect(classifyLatexmkProbe({ code: "ENOENT" })).toEqual({ available: false, cache: true });
  });

  it("does not cache a transient spawn error — stays available", () => {
    expect(classifyLatexmkProbe({ code: "ETIMEDOUT" })).toEqual({ available: true, cache: false });
  });

  it("does not cache a non-zero exit (numeric code) — stays available", () => {
    expect(classifyLatexmkProbe({ code: 1 })).toEqual({ available: true, cache: false });
  });
});

// #1414 (CodeRabbit, Minor): while a compile for an output PDF is in flight,
// further saves must coalesce to exactly ONE re-run — and that re-run must use
// the LATEST request's target/tab, not the stale target/tab captured by the
// original in-flight call's closure.
describe("runLatexmk coalescing", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function captureExec() {
    const calls: Array<{ args: string[]; cb: Parameters<LatexExec>[3] }> = [];
    const exec: LatexExec = (_cmd, args, _opts, cb) => {
      calls.push({ args, cb });
    };
    return { exec, calls };
  }

  function sink(): BridgeIo & { posted: any[] } {
    const posted: any[] = [];
    return { posted, visible: () => true, postToWebview: (m) => void posted.push(m) };
  }

  it("coalesces a mid-flight rerun to the latest request's tab", async () => {
    const { exec, calls } = captureExec();
    const io = sink();
    const detect = async () => true;
    const target = { dir: "/w", base: "a.tex", pdf: "/w/coalesce-s7.pdf" };

    // First save → compile in flight (exec captured, not yet completed).
    await runLatexmk(target, "tabA", io, { exec, detect });
    expect(calls.length).toBe(1);

    // Second save arrives while the first is still running → coalesced, no new
    // exec, latest request (tabB) remembered.
    await runLatexmk(target, "tabB", io, { exec, detect });
    expect(calls.length).toBe(1);

    // First compile completes → exactly ONE rerun fires…
    calls[0].cb(null, "", "");
    await flush();
    expect(calls.length).toBe(2);

    // …and it carries tabB (the latest), not the stale tabA from the closure.
    const compiling = io.posted.filter((m) => m.kind === "run-latex-status" && m.state === "compiling");
    expect(compiling.at(-1)?.tab).toBe("tabB");
  });

  it("claims the compile slot before the async availability probe (no double-spawn)", async () => {
    const { exec, calls } = captureExec();
    const io = sink();
    // A deferred probe: two saves for the same PDF arrive while it is pending.
    const resolvers: Array<(v: boolean) => void> = [];
    const detect = () => new Promise<boolean>((r) => resolvers.push(r));
    const target = { dir: "/w", base: "a.tex", pdf: "/w/slot-claim-s9.pdf" };

    const pA = runLatexmk(target, "tabA", io, { exec, detect });
    const pB = runLatexmk(target, "tabB", io, { exec, detect });
    // Probe still pending → nothing spawned yet.
    expect(calls.length).toBe(0);

    // Release the probe(s) and let both calls settle.
    resolvers.forEach((r) => r(true));
    await pA;
    await pB;
    await flush();

    // Exactly ONE latexmk spawned despite two concurrent saves — the slot must
    // be claimed synchronously, before the awaited probe, so the second save
    // coalesces instead of starting its own probe+compile.
    expect(calls.length).toBe(1);
  });
});
