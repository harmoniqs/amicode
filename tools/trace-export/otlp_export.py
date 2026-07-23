#!/usr/bin/env python3
"""
Export an amicode/opencode session from SQLite into:
  1. an OTLP / OpenInference trace JSON  (loads into Phoenix or Langfuse via their OTEL endpoints)
  2. a human-readable Markdown transcript

Pure stdlib. No dependencies.

Trace model (OpenInference span kinds):
  AGENT (session)
    └─ LLM  (one per assistant message = one agent step)
         └─ TOOL (one per tool part; carries args + result)

Usage:
  python3 otlp_export.py [SESSION_ID] [--db PATH] [--out DIR]
  python3 otlp_export.py --list          # list sessions and exit
"""
import sqlite3, json, hashlib, sys, os, argparse

DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode-dev.db")
DEFAULT_SESSION = "ses_07a00202fffe0RtGsdRuaiOq9R"   # richest: Rydberg, 228 msgs
DEFAULT_OUT = os.path.expanduser("~/amicode-trace-export")


def _id(prefix, s, n):
    h = hashlib.sha1(f"{prefix}:{s}".encode()).hexdigest()[:n]
    return h if set(h) != {"0"} else ("1" * n)  # avoid all-zero ids


def trace_id(session_id):  return _id("trace", session_id, 32)
def span_id(kind, key):    return _id(kind, key, 16)


def attr(key, val):
    """One OTLP KeyValue. Picks value type by Python type."""
    if isinstance(val, bool):
        v = {"boolValue": val}
    elif isinstance(val, int):
        v = {"intValue": str(val)}          # OTLP JSON encodes int64 as string
    elif isinstance(val, float):
        v = {"doubleValue": val}
    else:
        v = {"stringValue": "" if val is None else str(val)}
    return {"key": key, "value": v}


def ms_to_ns(ms):
    return str(int(ms) * 1_000_000) if ms else "0"


def load_session(con, session_id):
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    sess = cur.execute("SELECT * FROM session WHERE id=?", (session_id,)).fetchone()
    if not sess:
        sys.exit(f"session {session_id} not found in db")
    msgs = cur.execute(
        "SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id",
        (session_id,)).fetchall()
    parts = cur.execute(
        "SELECT id,message_id,data,time_created FROM part WHERE session_id=? ORDER BY time_created,id",
        (session_id,)).fetchall()
    parts_by_msg = {}
    for p in parts:
        parts_by_msg.setdefault(p["message_id"], []).append(p)
    return sess, msgs, parts_by_msg


def build_spans(sess, msgs, parts_by_msg):
    tid = trace_id(sess["id"])
    root_sid = span_id("session", sess["id"])
    spans = []

    starts, ends = [], []
    current_user_text = ""       # most recent user turn -> input for following LLM spans

    for m in msgs:
        md = json.loads(m["data"])
        role = md.get("role")
        mparts = parts_by_msg.get(m["id"], [])
        t = md.get("time", {}) or {}
        created = t.get("created", m["time_created"])
        completed = t.get("completed", created)
        starts.append(created); ends.append(completed)

        # collect this message's parts by type
        texts, reasonings, tools = [], [], []
        for p in mparts:
            pd = json.loads(p["data"])
            pt = pd.get("type")
            if pt == "text":
                texts.append(pd.get("text", ""))
            elif pt == "reasoning":
                reasonings.append(pd.get("text", ""))
            elif pt == "tool":
                tools.append((p, pd))

        if role == "user":
            current_user_text = "\n".join(texts).strip() or current_user_text
            continue  # user turns become input.value on the next LLM span

        # ---- assistant message -> LLM span ----
        llm_sid = span_id("msg", m["id"])
        tokens = md.get("tokens", {}) or {}
        cache = tokens.get("cache", {}) or {}
        out_text = "\n".join(texts).strip()
        reasoning = "\n".join(reasonings).strip()
        tool_names = [pd.get("tool") for _, pd in tools]

        output_value = out_text
        if not output_value and tool_names:
            output_value = "[tool call: " + ", ".join(tool_names) + "]"

        a = [
            attr("openinference.span.kind", "LLM"),
            attr("llm.model_name", md.get("modelID")),
            attr("llm.provider", md.get("providerID")),
            attr("llm.token_count.prompt", tokens.get("input", 0)),
            attr("llm.token_count.completion", tokens.get("output", 0)),
            attr("llm.token_count.total", tokens.get("total", 0)),
            attr("llm.token_count.completion_details.reasoning", tokens.get("reasoning", 0)),
            attr("llm.token_count.prompt_details.cache_read", cache.get("read", 0)),
            attr("llm.token_count.prompt_details.cache_write", cache.get("write", 0)),
            attr("input.value", current_user_text),
            attr("input.mime_type", "text/plain"),
            attr("output.value", output_value),
            attr("output.mime_type", "text/plain"),
            attr("llm.input_messages.0.message.role", "user"),
            attr("llm.input_messages.0.message.content", current_user_text),
            attr("llm.output_messages.0.message.role", "assistant"),
            attr("llm.output_messages.0.message.content", out_text),
            # amicode-specific extras (visible in Phoenix/Langfuse attribute panels)
            attr("amicode.agent", md.get("agent")),
            attr("amicode.reasoning", reasoning),
            attr("amicode.finish", md.get("finish")),
            attr("amicode.message_id", m["id"]),
        ]
        # tool calls advertised on the assistant message
        for i, name in enumerate(tool_names):
            a.append(attr(f"llm.output_messages.0.message.tool_calls.{i}.tool_call.function.name", name))

        err = md.get("error")
        status = {"code": "STATUS_CODE_ERROR", "message": json.dumps(err)[:400]} if err else {"code": "STATUS_CODE_OK"}

        spans.append({
            "traceId": tid, "spanId": llm_sid, "parentSpanId": root_sid,
            "name": (out_text[:60] or (tool_names[0] if tool_names else "assistant step")),
            "kind": 1,
            "startTimeUnixNano": ms_to_ns(created),
            "endTimeUnixNano": ms_to_ns(completed),
            "attributes": a,
            "status": status,
        })

        # ---- tool parts -> TOOL spans (children of the LLM span) ----
        for p, pd in tools:
            st = pd.get("state", {}) or {}
            tt = st.get("time", {}) or {}
            inp = st.get("input", {})
            outp = st.get("output", "")
            tool_status = ({"code": "STATUS_CODE_ERROR",
                            "message": str(st.get("error", ""))[:400]}
                           if st.get("status") == "error" else {"code": "STATUS_CODE_OK"})
            spans.append({
                "traceId": tid,
                "spanId": span_id("tool", pd.get("callID") or p["id"]),
                "parentSpanId": llm_sid,
                "name": pd.get("tool", "tool"),
                "kind": 1,
                "startTimeUnixNano": ms_to_ns(tt.get("start", created)),
                "endTimeUnixNano": ms_to_ns(tt.get("end", tt.get("start", completed))),
                "attributes": [
                    attr("openinference.span.kind", "TOOL"),
                    attr("tool.name", pd.get("tool")),
                    attr("tool.parameters", json.dumps(inp, ensure_ascii=False)),
                    attr("input.value", json.dumps(inp, ensure_ascii=False)),
                    attr("input.mime_type", "application/json"),
                    attr("output.value", outp if isinstance(outp, str) else json.dumps(outp, ensure_ascii=False)),
                    attr("output.mime_type", "text/plain"),
                    attr("amicode.tool.call_id", pd.get("callID")),
                    attr("amicode.tool.status", st.get("status")),
                ],
                "status": tool_status,
            })

    # ---- root AGENT span ----
    root = {
        "traceId": tid, "spanId": root_sid,
        "name": sess["title"] or "amicode session",
        "kind": 1,
        "startTimeUnixNano": ms_to_ns(min(starts) if starts else 0),
        "endTimeUnixNano": ms_to_ns(max(ends) if ends else 0),
        "attributes": [
            attr("openinference.span.kind", "AGENT"),
            attr("session.id", sess["id"]),
            attr("amicode.agent", sess["agent"]),
            attr("llm.model_name", (json.loads(sess["model"]) or {}).get("id") if sess["model"] else None),
            attr("input.value", sess["title"]),
            attr("output.value", sess["summary_diffs"] if "summary_diffs" in sess.keys() else ""),
            attr("llm.token_count.prompt", sess["tokens_input"]),
            attr("llm.token_count.completion", sess["tokens_output"]),
            attr("llm.token_count.completion_details.reasoning", sess["tokens_reasoning"]),
            attr("llm.token_count.prompt_details.cache_read", sess["tokens_cache_read"]),
            attr("amicode.cost", float(sess["cost"] or 0)),
            attr("amicode.directory", sess["directory"]),
        ],
        "status": {"code": "STATUS_CODE_OK"},
    }
    spans.insert(0, root)
    return spans


def to_otlp(spans):
    return {"resourceSpans": [{
        "resource": {"attributes": [
            attr("service.name", "amicode"),
            attr("service.namespace", "harmoniqs"),
        ]},
        "scopeSpans": [{
            "scope": {"name": "amicode.sqlite.export", "version": "1"},
            "spans": spans,
        }],
    }]}


def to_markdown(sess, msgs, parts_by_msg, tool_cap=4000):
    L = [f"# {sess['title']}", "",
         f"- **session**: `{sess['id']}`",
         f"- **agent**: {sess['agent']}   **model**: {(json.loads(sess['model']) or {}).get('id') if sess['model'] else '?'}",
         f"- **dir**: `{sess['directory']}`",
         f"- **tokens** in/out/reason/cacheR: {sess['tokens_input']}/{sess['tokens_output']}/{sess['tokens_reasoning']}/{sess['tokens_cache_read']}",
         f"- **cost**: {sess['cost']}", "", "---", ""]
    step = 0
    for m in msgs:
        md = json.loads(m["data"]); role = md.get("role")
        mparts = parts_by_msg.get(m["id"], [])
        texts, reasonings, tools = [], [], []
        for p in mparts:
            pd = json.loads(p["data"]); pt = pd.get("type")
            if pt == "text": texts.append(pd.get("text", ""))
            elif pt == "reasoning": reasonings.append(pd.get("text", ""))
            elif pt == "tool": tools.append(pd)
        if role == "user":
            body = "\n".join(texts).strip()
            if body:
                L += [f"## 👤 user", "", body, ""]
            continue
        step += 1
        L += [f"## 🤖 assistant · step {step}  ·  {md.get('finish','')}", ""]
        if reasonings:
            r = "\n".join(reasonings).strip()
            L += ["<details><summary>reasoning</summary>", "", "> " + r.replace("\n", "\n> "), "", "</details>", ""]
        for pd in tools:
            st = pd.get("state", {}) or {}
            out = st.get("output", "")
            out = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            if len(out) > tool_cap: out = out[:tool_cap] + f"\n…[+{len(out)-tool_cap} chars]"
            L += [f"**🔧 {pd.get('tool')}**  `{st.get('status')}`",
                  "```json", json.dumps(st.get("input", {}), indent=2, ensure_ascii=False), "```",
                  "output:", "```", out, "```", ""]
        body = "\n".join(texts).strip()
        if body:
            L += [body, ""]
        L += ["---", ""]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", nargs="?", default=DEFAULT_SESSION)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    if args.list:
        for r in con.execute("SELECT id,title FROM session ORDER BY time_created"):
            n = con.execute("SELECT COUNT(*) FROM message WHERE session_id=?", (r["id"],)).fetchone()[0]
            print(f"{r['id']}  ({n:>3} msgs)  {r['title']}")
        return

    sess, msgs, parts_by_msg = load_session(con, args.session)
    spans = build_spans(sess, msgs, parts_by_msg)
    otlp = to_otlp(spans)
    md = to_markdown(sess, msgs, parts_by_msg)

    os.makedirs(args.out, exist_ok=True)
    base = os.path.join(args.out, args.session)
    with open(base + ".otlp.json", "w") as f:
        json.dump(otlp, f, ensure_ascii=False, indent=2)
    with open(base + ".md", "w") as f:
        f.write(md)

    n_llm = sum(1 for s in spans if any(a["key"] == "openinference.span.kind" and a["value"]["stringValue"] == "LLM" for a in s["attributes"]))
    n_tool = sum(1 for s in spans if any(a["key"] == "openinference.span.kind" and a["value"]["stringValue"] == "TOOL" for a in s["attributes"]))
    print(f"session : {args.session}  ({sess['title']})")
    print(f"spans   : {len(spans)}  (1 AGENT + {n_llm} LLM + {n_tool} TOOL)")
    print(f"wrote   : {base}.otlp.json")
    print(f"          {base}.md")


if __name__ == "__main__":
    main()
