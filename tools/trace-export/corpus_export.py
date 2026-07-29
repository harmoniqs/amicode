#!/usr/bin/env python3
"""Reconstruct a readable session transcript + distilled OTLP from the RUN CORPUS only.

This is otlp_export.py's output, produced WITHOUT the user's machine.
otlp_export.py reads opencode's local SQLite (~/.local/share/opencode), so it can
only ever export your own sessions. This reads the cloud corpus instead, so it
works for any submitter.

That is possible because the wire capture keeps the pieces that matter, and the
16 KB attribute cap lands almost entirely on the ONE attribute that is redundant:

  ai.toolCall.args      38/38 intact   (max 437 B)   <- tool INPUTS complete
  ai.toolCall.result    35/37 intact                 <- tool OUTPUTS ~95% complete
  ai.response.text      56/56 intact   (max 721 B)
  ai.response.reasoning 52/52 intact   (max 10.8 KB)
  ai.prompt             1/28  intact                 <- CLIPPED, but see below

ai.prompt is the whole conversation history re-sent on every single call, so it
is ~quadratically redundant: turn N's prompt restates turns 1..N-1, which we
already hold as untruncated reasoning/text/tool spans. The only content that is
irrecoverable is a single user or tool message larger than 16 KB. So the
transcript below is rebuilt from the untruncated pieces, not from ai.prompt.

Usage:
  python3 corpus_export.py <dir-of-.otlp.gz> <outdir>
"""
import glob
import gzip
import json
import os
import re
import sys
from collections import defaultdict

CAP = 16384
TITLE_BOILERPLATE = "generate a title for this conversation"
TEXT_RE = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)+)"')


def attrs(s):
    out = {}
    for a in s.get("attributes", []):
        v = a.get("value", {})
        out[a["key"]] = next(iter(v.values())) if v else None
    return out


def load(src):
    spans, resource = {}, {}
    for f in sorted(glob.glob(os.path.join(src, "**", "*.otlp.gz"), recursive=True)):
        raw = gzip.decompress(open(f, "rb").read())
        if not raw.lstrip().startswith(b"{"):
            continue
        for rs in json.loads(raw).get("resourceSpans", []):
            for a in rs.get("resource", {}).get("attributes", []):
                v = a.get("value", {})
                resource.setdefault(a["key"], next(iter(v.values())) if v else None)
            for ss in rs.get("scopeSpans", []):
                for s in ss.get("spans", []):
                    spans[s["spanId"]] = s
    return spans, resource


def clipped(v):
    return isinstance(v, str) and len(v) >= CAP - 2


def first_user_request(llm):
    """The user's opening ask. Recoverable because opencode's title-generator call
    is SMALL -- it carries [system, 'Generate a title...', <the real request>] and
    so escapes the cap even when every later prompt is clipped."""
    for s, a in sorted(llm, key=lambda x: int(x[0]["startTimeUnixNano"])):
        p = a.get("ai.prompt") or ""
        cands = []
        try:
            for m in json.loads(p).get("messages", []):
                if m.get("role") != "user":
                    continue
                c = m.get("content")
                if isinstance(c, str):
                    cands.append(c)
                elif isinstance(c, list):
                    cands += [x.get("text", "") for x in c if isinstance(x, dict)]
        except Exception:
            cands += [m.group(1) for m in TEXT_RE.finditer(p)]
        for t in cands:
            t = (t or "").replace("\\n", "\n").strip()
            if t and TITLE_BOILERPLATE not in t.lower():
                return t
    return None


def jfmt(v):
    if v is None:
        return ""
    try:
        return json.dumps(json.loads(v), indent=2)[:4000]
    except Exception:
        return str(v)[:4000]


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    spans, resource = load(src)

    sessions = defaultdict(lambda: {"llm": [], "tool": [], "exec": []})
    for s in spans.values():
        a = attrs(s)
        sid = a.get("ai.telemetry.metadata.sessionId") or a.get("session.id")
        if not sid:
            continue
        if s["name"] == "ai.streamText":
            sessions[sid]["llm"].append((s, a))
        elif s["name"] == "ai.toolCall":
            sessions[sid]["tool"].append((s, a))
        elif s["name"] == "Tool.execute":
            sessions[sid]["exec"].append((s, a))

    written = []
    for sid, g in sessions.items():
        if not g["llm"] and not g["tool"]:
            continue
        # Drop opencode's title-generator call from the step list -- it is
        # housekeeping, not a turn the user took.
        steps = [(s, a) for s, a in g["llm"]
                 if TITLE_BOILERPLATE not in (a.get("ai.prompt") or "").lower()]
        if not steps:
            steps = g["llm"]
        steps.sort(key=lambda x: int(x[0]["startTimeUnixNano"]))
        tools = sorted(g["tool"], key=lambda x: int(x[0]["startTimeUnixNano"]))
        status = {a.get("tool.call_id"): "completed" for _, a in g["exec"]}

        title = first_user_request(g["llm"]) or sid
        model = next((a.get("ai.model.id") for _, a in g["llm"] if a.get("ai.model.id")), "?")
        tin = sum(int(a.get("ai.usage.inputTokens") or 0) for _, a in g["llm"])
        tout = sum(int(a.get("ai.usage.outputTokens") or 0) for _, a in g["llm"])
        treas = sum(int(a.get("ai.usage.reasoningTokens") or 0) for _, a in g["llm"])
        tcache = sum(int(a.get("ai.usage.cachedInputTokens") or 0) for _, a in g["llm"])
        n_clip = sum(1 for _, a in tools if clipped(a.get("ai.toolCall.result")))

        L = [f"# {title.splitlines()[0][:110]}", ""]
        L += [f"- **session**: `{sid}`",
              f"- **submitter**: `{resource.get('amicode.user','?')[:12]}…` (identity verified server-side)",
              f"- **repo**: `{resource.get('amicode.repo')}` @ `{resource.get('amicode.git_ref')}`",
              f"- **model**: {model}   **client**: {resource.get('amicode.client')} / opencode {resource.get('service.version')}",
              f"- **tokens** in/out/reason/cacheR: {tin}/{tout}/{treas}/{tcache}",
              f"- **steps**: {len(steps)} llm · {len(tools)} tool calls",
              f"- **source**: run corpus (cloud) — reconstructed WITHOUT local sqlite",
              ""]
        if n_clip:
            L += [f"> ⚠️ {n_clip} of {len(tools)} tool results were truncated at the 16 KB "
                  f"attribute cap and are shown clipped.", ""]
        L += ["---", "", "## 👤 user", "", title, ""]

        # Pair each llm step with the tool calls it requested (ai.response.toolCalls
        # lists the ids), falling back to time order for anything unmatched.
        claimed = set()
        for i, (s, a) in enumerate(steps, 1):
            fin = a.get("ai.response.finishReason", "?")
            L += [f"## 🤖 assistant · step {i}  ·  {fin}", ""]
            if a.get("ai.response.reasoning"):
                L += ["<details><summary>reasoning</summary>", ""]
                L += ["> " + ln for ln in a["ai.response.reasoning"].splitlines()]
                L += ["", "</details>", ""]
            if a.get("ai.response.text", "").strip():
                L += [a["ai.response.text"], ""]
            want = []
            try:
                want = [tc.get("toolCallId") for tc in json.loads(a.get("ai.response.toolCalls") or "[]")]
            except Exception:
                pass
            for _, ta in tools:
                cid = ta.get("ai.toolCall.id")
                if cid in want and cid not in claimed:
                    claimed.add(cid)
                    L += [f"**🔧 {ta.get('ai.toolCall.name')}**  `{status.get(cid,'?')}`",
                          "```json", jfmt(ta.get("ai.toolCall.args")), "```",
                          "output:", "```", jfmt(ta.get("ai.toolCall.result")),
                          ("… [TRUNCATED at 16 KB cap]" if clipped(ta.get("ai.toolCall.result")) else ""),
                          "```", ""]
            u = [f"{k.split('.')[-1]}={a[k]}" for k in
                 ("ai.usage.inputTokens", "ai.usage.outputTokens", "ai.usage.reasoningTokens") if a.get(k)]
            if u:
                L += [f"_tokens: {'  '.join(u)}_", ""]

        orphan = [t for t in tools if t[1].get("ai.toolCall.id") not in claimed]
        if orphan:
            L += [f"## 🔧 unpaired tool calls ({len(orphan)})", "",
                  "_Requested by an llm span whose ai.response.toolCalls was clipped or not captured._", ""]
            for _, ta in orphan:
                L += [f"**🔧 {ta.get('ai.toolCall.name')}**", "```json",
                      jfmt(ta.get("ai.toolCall.args")), "```", "output:", "```",
                      jfmt(ta.get("ai.toolCall.result")), "```", ""]

        md = os.path.join(outdir, f"{sid}.md")
        open(md, "w").write("\n".join(L))
        js = os.path.join(outdir, f"{sid}.spans.json")
        json.dump({"session": sid, "resource": resource,
                   "steps": [{"name": s["name"], **a} for s, a in steps],
                   "tools": [{"name": s["name"], **a} for s, a in tools]},
                  open(js, "w"), indent=2)
        written.append((sid, title, len(steps), len(tools), n_clip, md))

    print(f"raw spans: {len(spans)}   sessions reconstructed: {len(written)}\n")
    for sid, title, ns, nt, nc, md in written:
        print(f"  {sid}\n    {title.splitlines()[0][:80]!r}\n    {ns} steps, {nt} tool calls, {nc} clipped -> {md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
