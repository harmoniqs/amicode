#!/usr/bin/env python3
"""Distil raw run-corpus OTLP into the clean OpenInference shape, SERVER-SIDE.

WHY THIS EXISTS (and why otlp_export.py cannot be used here):
otlp_export.py builds its clean AGENT->LLM->TOOL spans by reading opencode's
LOCAL SQLite session store (~/.local/share/opencode). That file lives on the
USER's machine. For anyone but yourself it is unreachable, so the good pipeline
does not apply to corpus data at all.

It does not need to. The raw wire capture already carries every semantic
attribute the AI SDK emits -- ai.prompt, ai.response.text/reasoning,
ai.toolCall.args/result, ai.usage.*, ai.model.id, and the real opencode session
id -- it is just diluted ~140:1 by opencode's own internal instrumentation
(sql.execute, Session.getPart, SessionProcessor.*, http.server). So the clean
view is a FILTER over the corpus, not a different data source.

Mapping (mirrors otlp_export.py's output so both render identically):
  ai.streamText  -> openinference.span.kind=LLM   (+ llm.model_name, token counts)
  ai.toolCall    -> openinference.span.kind=TOOL  (+ tool.name, args/result)
  synthetic root -> openinference.span.kind=AGENT (one per opencode session)

Spans are re-parented onto the synthetic session root, because the real parents
(LLM.run, SessionTools.resolve) are exactly the noise being removed -- keeping
them would drag the whole internal tree back in.

Usage:
  OTLP_AUTH_BASIC=pk:sk python3 corpus_distill.py <dir-of-.otlp.gz> [endpoint] [label]
"""
import base64
import glob
import gzip
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict

from opentelemetry.proto.collector.trace.v1 import trace_service_pb2 as ts
from opentelemetry.proto.common.v1 import common_pb2 as cp
from opentelemetry.proto.resource.v1 import resource_pb2 as rp


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
        doc = json.loads(raw)
        for rs in doc.get("resourceSpans", []):
            for a in rs.get("resource", {}).get("attributes", []):
                v = a.get("value", {})
                resource.setdefault(a["key"], next(iter(v.values())) if v else None)
            for ss in rs.get("scopeSpans", []):
                for s in ss.get("spans", []):
                    spans[s["spanId"]] = s
    return spans, resource


def sv(x):
    av = cp.AnyValue()
    av.string_value = "" if x is None else (x if isinstance(x, str) else json.dumps(x))
    return av


def iv(x):
    av = cp.AnyValue()
    av.int_value = int(x)
    return av


def kv(k, val):
    o = cp.KeyValue(key=k)
    o.value.CopyFrom(val)
    return o


def synth_id(*parts, n=8):
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()[:n]


# opencode's FIRST llm call in a session is its own title generator (system
# prompt: "You are a title generator"), and its message list is
# [system, user("Generate a title for this conversation:"), user(<the real task>)].
# Naming the root from "first user message" therefore labels every session with
# opencode's internal housekeeping prompt instead of what the user asked.
TITLE_BOILERPLATE = "generate a title for this conversation"

# ai.prompt is frequently INVALID JSON: OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=16384
# (set by amicode's env injection) truncates it mid-string. So never rely on
# json.loads succeeding -- fall back to scraping "text" values out of the
# fragment. This is the fidelity cost of the attribute cap, visible in practice.
TEXT_RE = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.){4,})"')


def user_texts(prompt_json):
    """Every user-authored text in an ai.prompt, tolerating truncation."""
    out = []
    try:
        for m in json.loads(prompt_json or "{}").get("messages", []):
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, str):
                out.append(c)
            elif isinstance(c, list):
                out.extend(p.get("text", "") for p in c if isinstance(p, dict))
    except Exception:
        out.extend(m.group(1) for m in TEXT_RE.finditer(prompt_json or ""))
    return [t.strip() for t in out if t and t.strip()]


def prompt_parses(p):
    try:
        json.loads(p or "{}")
        return True
    except Exception:
        return False


def extract_title(llm_spans):
    """The user's actual opening request, skipping opencode's title-gen prompt."""
    for s, a in sorted(llm_spans, key=lambda x: int(x[0]["startTimeUnixNano"])):
        for t in user_texts(a.get("ai.prompt")):
            if TITLE_BOILERPLATE in t.lower():
                continue
            t = t.replace("\\n", " ").strip()
            if t:
                return t.splitlines()[0][:100]
    return None


def resolve_submitter(src, explicit):
    """The token-verified submitter. Explicit flag wins; otherwise read the
    sidecar that fetch_corpus writes (S3 object metadata is NOT preserved by
    `aws s3 sync`, so it has to be carried out-of-band or passed in)."""
    if explicit:
        return explicit
    side = os.path.join(src, "_submitter")
    if os.path.exists(side):
        v = open(side).read().strip()
        if v:
            return v
    return None


def main():
    argv = sys.argv[1:]
    submitter = None
    if "--submitter" in argv:
        i = argv.index("--submitter")
        submitter = argv[i + 1]
        del argv[i:i + 2]
    src = argv[0]
    endpoint = argv[1] if len(argv) > 1 else "http://localhost:3000/api/public/otel/v1/traces"
    label = argv[2] if len(argv) > 2 else "distilled"
    submitter = resolve_submitter(src, submitter)

    spans, resource = load(src)
    # Group the semantic spans by the REAL opencode session id (a per-span
    # attribute), not by the corpus prefix -- the prefix is a per-activation stub
    # and BatchSpanProcessor coalesces multiple sessions into one export.
    by_session = defaultdict(lambda: {"llm": [], "tool": []})
    for s in spans.values():
        a = attrs(s)
        sid = a.get("ai.telemetry.metadata.sessionId") or a.get("session.id")
        if not sid:
            continue
        if s["name"] == "ai.streamText":
            by_session[sid]["llm"].append((s, a))
        elif s["name"] == "ai.toolCall":
            by_session[sid]["tool"].append((s, a))

    req = ts.ExportTraceServiceRequest()
    pb_rs = req.resource_spans.add()
    res_attrs = [kv(k, sv(v)) for k, v in resource.items()]
    res_attrs.append(kv("amicode.view", sv("distilled")))
    pb_rs.resource.CopyFrom(rp.Resource(attributes=res_attrs))
    pb_ss = pb_rs.scope_spans.add()
    pb_ss.scope.CopyFrom(cp.InstrumentationScope(name="amicode.corpus.distill", version="1"))

    stats = Counter()
    for sid, groups in sorted(by_session.items()):
        members = groups["llm"] + groups["tool"]
        if not members:
            continue
        trace_id = synth_id("trace", label, sid, n=16)
        root_id = synth_id("root", label, sid)
        start = min(int(s["startTimeUnixNano"]) for s, _ in members)
        end = max(int(s["endTimeUnixNano"]) for s, _ in members)

        title = extract_title(groups["llm"]) or sid

        root = pb_ss.spans.add()
        root.trace_id, root.span_id = trace_id, root_id
        root.name = title
        root.kind = 1
        root.start_time_unix_nano, root.end_time_unix_nano = start, end
        # --- Identity ------------------------------------------------------
        # Langfuse's OTLP mapping was verified empirically against this instance:
        # `langfuse.user.id` -> trace.userId (it WINS over a plain `user.id`),
        # `langfuse.session.id` -> trace.sessionId, `langfuse.tags` -> tags.
        #
        # WHICH identity to use matters. Three candidates exist and only one is
        # trustworthy:
        #   submitter                        <- AUTHORITATIVE. Derived by the
        #       ingest lambda from the sha256 of the caller's bearer token and
        #       stamped into S3 object metadata. Never client-supplied, so it
        #       cannot be spoofed -- that is the entire point of the bearer-auth
        #       design. It is NOT in the OTLP payload, so it must be passed in.
        #   ai.telemetry.metadata.userId     <- client-reported (opencode config,
        #       e.g. "raghavchari"). Convenient, spoofable.
        #   amicode.user                     <- VS Code machineId hash. Pseudonymous
        #       per-install handle, also client-supplied.
        # So: prefer the submitter; fall back to the client value but TAG the
        # trace `identity:client-reported` so nobody mistakes it for verified.
        client_user = next((a.get("ai.telemetry.metadata.userId")
                            for _, a in groups["llm"]
                            if a.get("ai.telemetry.metadata.userId")), None)
        user_id = submitter or client_user or resource.get("amicode.user")
        verified = bool(submitter)
        tags = ["run-corpus", "distilled",
                f"identity:{'verified' if verified else 'client-reported'}"]
        if resource.get("amicode.repo"):
            tags.append(f"repo:{resource['amicode.repo']}")

        root.attributes.extend([
            kv("openinference.span.kind", sv("AGENT")),
            # Langfuse-native attribution (verified mapping above).
            kv("langfuse.user.id", sv(user_id)),
            kv("langfuse.session.id", sv(sid)),
            kv("langfuse.tags", sv(json.dumps(tags))),
            # Keep every candidate visible and labelled, so the provenance of
            # the userId above is auditable rather than implicit.
            kv("amicode.submitter", sv(submitter or "")),
            kv("amicode.identity.verified", sv(str(verified).lower())),
            kv("amicode.opencode_user", sv(client_user or "")),
            kv("amicode.machine_id", sv(resource.get("amicode.user") or "")),
            kv("amicode.session.id", sv(sid)),
            kv("amicode.repo", sv(resource.get("amicode.repo"))),
            kv("amicode.git_ref", sv(resource.get("amicode.git_ref"))),
            kv("input.value", sv(title)),
            kv("input.mime_type", sv("text/plain")),
        ])
        stats["AGENT"] += 1

        for s, a in sorted(members, key=lambda x: int(x[0]["startTimeUnixNano"])):
            sp = pb_ss.spans.add()
            sp.trace_id = trace_id
            sp.span_id = synth_id("span", label, s["spanId"])
            sp.parent_span_id = root_id  # flatten onto the agent root
            sp.start_time_unix_nano = int(s["startTimeUnixNano"])
            sp.end_time_unix_nano = int(s["endTimeUnixNano"])
            sp.kind = 1
            if s["name"] == "ai.streamText":
                sp.name = f"LLM {a.get('ai.model.id','?')}"
                out = a.get("ai.response.text") or a.get("ai.response.reasoning") or ""
                sp.attributes.extend([
                    kv("openinference.span.kind", sv("LLM")),
                    kv("llm.model_name", sv(a.get("ai.model.id"))),
                    kv("llm.provider", sv(a.get("ai.model.provider"))),
                    kv("input.value", sv(a.get("ai.prompt"))),
                    kv("amicode.prompt.truncated", sv(str(not prompt_parses(a.get("ai.prompt"))).lower())),
                    kv("input.mime_type", sv("application/json")),
                    kv("output.value", sv(out)),
                    kv("output.mime_type", sv("text/plain")),
                    kv("llm.finish_reason", sv(a.get("ai.response.finishReason"))),
                ])
                for src_k, dst_k in (
                    ("ai.usage.inputTokens", "llm.token_count.prompt"),
                    ("ai.usage.outputTokens", "llm.token_count.completion"),
                    ("ai.usage.totalTokens", "llm.token_count.total"),
                    ("ai.usage.reasoningTokens", "llm.token_count.completion_details.reasoning"),
                    ("ai.usage.cachedInputTokens", "llm.token_count.prompt_details.cache_read"),
                ):
                    if a.get(src_k) is not None:
                        sp.attributes.append(kv(dst_k, iv(a[src_k])))
                if a.get("ai.response.toolCalls"):
                    sp.attributes.append(kv("llm.output_messages.0.message.tool_calls", sv(a["ai.response.toolCalls"])))
                stats["LLM"] += 1
            else:
                name = a.get("ai.toolCall.name", "tool")
                sp.name = name
                sp.attributes.extend([
                    kv("openinference.span.kind", sv("TOOL")),
                    kv("tool.name", sv(name)),
                    kv("tool.parameters", sv(a.get("ai.toolCall.args"))),
                    kv("input.value", sv(a.get("ai.toolCall.args"))),
                    kv("input.mime_type", sv("application/json")),
                    kv("output.value", sv(a.get("ai.toolCall.result"))),
                    kv("output.mime_type", sv("application/json")),
                    kv("amicode.tool.call_id", sv(a.get("ai.toolCall.id"))),
                ])
                stats["TOOL"] += 1

    body = req.SerializeToString()
    headers = {"Content-Type": "application/x-protobuf"}
    auth = os.environ.get("OTLP_AUTH_BASIC")
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
    try:
        with urllib.request.urlopen(urllib.request.Request(endpoint, data=body, headers=headers), timeout=120) as r:
            status, resp = r.status, r.read()[:200]
    except urllib.error.HTTPError as e:
        status, resp = e.code, e.read()[:300]

    total = sum(len(s.get("spans", [])) for s in [{"spans": pb_ss.spans}])
    print(f"raw spans in    : {len(spans)}")
    print(f"sessions found  : {len(by_session)}")
    print(f"distilled spans : {len(pb_ss.spans)}  {dict(stats)}")
    print(f"reduction       : {len(spans)} -> {len(pb_ss.spans)}  ({len(spans)/max(len(pb_ss.spans),1):.0f}:1)")
    print(f"repo            : {resource.get('amicode.repo')}@{resource.get('amicode.git_ref')}")
    print(f"user (langfuse) : {submitter or '(none passed)'}"
          f"{'  [VERIFIED submitter]' if submitter else '  [falling back to CLIENT-REPORTED id -- pass --submitter]'}")
    print(f"POST {endpoint} -> HTTP {status} {resp[:120]!r}")
    return 0 if status in (200, 202, 204) else 1


if __name__ == "__main__":
    sys.exit(main())
