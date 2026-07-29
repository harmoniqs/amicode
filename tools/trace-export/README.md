# amicode → Phoenix / Langfuse trace export

Two sources, one output shape.

**Local (your own sessions):** `otlp_export.py` reads opencode's SQLite
(`~/.local/share/opencode`) and emits a clean OTLP / OpenInference trace.

**Cloud (anyone's sessions):** `corpus_distill.py` / `corpus_export.py` read the
run corpus instead. This matters because SQLite lives on the *user's machine* —
so the local path can only ever export your own runs. To look at a teammate's
run you would otherwise have to ask them to send you their database.

You don't have to. The raw wire capture already carries every semantic
attribute the AI SDK emits; it is just diluted ~300:1 by opencode's own internal
instrumentation (`sql.execute`, `Session.getPart`, `SessionProcessor.*`,
`http.server`). The clean view is a **filter over the corpus**, not a different
data source.

## Files
- `otlp_export.py` — pure-stdlib converter, SQLite → OTLP JSON + transcript
- `corpus_distill.py` — corpus `*.otlp.gz` → distilled trace, POSTed to Langfuse/Phoenix
- `corpus_export.py` — corpus `*.otlp.gz` → `<session>.md` transcript + `<session>.spans.json`
- `push_otlp.py` — OTLP JSON → protobuf → collector (viewers reject OTLP/JSON; see below)
- `<session>.otlp.json` — OTLP `ExportTraceServiceRequest` JSON, OpenInference attributes
- `<session>.md` — human-readable transcript

## Corpus workflow

```bash
# 1. pull a session's raw objects (prefix is the per-activation session id)
aws s3 sync s3://harmoniqs-run-corpus-production-<acct>/v1/production/<date>/<prefix>/ ./corpus/

# 2. record the token-verified submitter -- S3 object metadata is NOT preserved
#    by `aws s3 sync`, so carry it out-of-band (or pass --submitter)
aws s3api head-object --bucket harmoniqs-run-corpus-production-<acct> \
  --key <one-object-key> --query 'Metadata.submitter' --output text > ./corpus/_submitter

# 3. readable transcript
python3 corpus_export.py ./corpus ~/traces-out

# 4. into Langfuse
OTLP_AUTH_BASIC=pk-lf-…:sk-lf-… python3 corpus_distill.py \
  --submitter raghav ./corpus http://localhost:3000/api/public/otel/v1/traces raghav
```

### Identity: use the submitter, not the client-reported id

Three user identities appear in this data and only one is trustworthy:

| source | trustworthy? | what it is |
| --- | --- | --- |
| `submitter` (S3 object metadata) | **yes** | derived by the ingest lambda from sha256 of the caller's bearer token; never client-supplied |
| `ai.telemetry.metadata.userId` | no | opencode config value, e.g. `raghavchari` — spoofable |
| `amicode.user` | no | VS Code `machineId` hash; pseudonymous per-install handle |

`corpus_distill.py` prefers `--submitter`, falls back to the client-reported id,
and **tags the trace `identity:verified` or `identity:client-reported`** so the
provenance is never ambiguous. All three are also written as
`amicode.submitter` / `amicode.opencode_user` / `amicode.machine_id`.

Langfuse's OTLP attribute mapping was verified empirically against a local
instance: **`langfuse.user.id` → `trace.userId`** (it wins over a plain
`user.id`, which is silently ignored), `langfuse.session.id` → `trace.sessionId`,
`langfuse.tags` (JSON array string) → tags.

### Known fidelity limit: the 16 KB attribute cap

amicode injects `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=16384`, which clips long
attribute values. Measured on a real session:

| attribute | intact | note |
| --- | --- | --- |
| `ai.toolCall.args` | 38/38 | tool inputs complete |
| `ai.toolCall.result` | 35/37 | tool outputs ~95% complete |
| `ai.response.text` | 56/56 | complete |
| `ai.response.reasoning` | 52/52 | complete |
| `ai.prompt` | 1/28 | **clipped — often invalid JSON** |

`ai.prompt` is the whole conversation re-sent on every call, so it is
quadratically redundant: turn N restates turns 1..N-1, which we already hold as
untruncated reasoning/text/tool spans. Both corpus scripts therefore rebuild the
transcript from the pieces and never rely on `ai.prompt` parsing — they scrape it
with a regex fallback and mark spans `amicode.prompt.truncated`.

The user's opening request still survives, via a quirk worth knowing: opencode's
first LLM call in a session is its own *title generator* (`[system, "Generate a
title for this conversation:", <the real request>]`) and is small enough to escape
the cap. That is where root titles come from — and why naming a root from "first
user message" without skipping the boilerplate labels every session
`Generate a title for this conversation:`.

What is genuinely lost: any single tool result over 16 KB. Those are marked
`[TRUNCATED at 16 KB cap]` in the transcript rather than silently dropped.

## Span model
```
AGENT  (session)
  └─ LLM   (one per assistant message = one agent step; carries tokens, reasoning, finish reason)
       └─ TOOL (one per tool call; carries args + result + status)
```

## Re-run / pick another session
```bash
python3 otlp_export.py --list                 # list all sessions in the db
python3 otlp_export.py <SESSION_ID>           # export a specific one
python3 otlp_export.py --db ~/.local/share/opencode/opencode.db <SESSION_ID>
```

## Pushing (both viewers want OTLP **protobuf**, not JSON)

Plain `curl` with `application/json` does NOT work: Phoenix 19.x returns 415, and
OTLP/JSON encodes trace/span ids as hex (not base64) so a generic JSON→proto parse
fails too. Use `push_otlp.py`, which builds the protobuf by hand and POSTs it.
It needs a python with `opentelemetry-proto` — the Phoenix venv has it:

```bash
VP=/home/jack/.venv/bin/python3
```

### Phoenix (local, nothing leaves the machine)
```bash
# server: pip install arize-phoenix && phoenix serve   (UI + collector on :6006)
$VP push_otlp.py ses_07a00202fffe0RtGsdRuaiOq9R.otlp.json http://localhost:6006/v1/traces
# open http://localhost:6006
```

### Langfuse (self-hosted locally via ~/langfuse docker compose — stays on the box)
```bash
export OTLP_AUTH_BASIC="pk-lf-...:sk-lf-..."     # project keys (in ~/langfuse/.env)
$VP push_otlp.py ses_07a00202fffe0RtGsdRuaiOq9R.otlp.json \
    http://localhost:3000/api/public/otel/v1/traces
# ingestion is async (worker -> clickhouse); trace appears after a few seconds.
# open http://localhost:3000
```
Langfuse maps OpenInference `LLM` spans -> `GENERATION` observations, `TOOL` -> `TOOL`.
For Langfuse **cloud**, use the same command with the cloud endpoint + keys — but that
is external egress of the raw chain-of-thought; scrub `amicode.reasoning` first.

## Notes
- `cost` is 0 across the board — these runs used the free `deepseek-v4-flash-free` model.
- The LLM span `input.value` is the *triggering user turn*, not the full assembled prompt —
  amicode does not persist the concatenated prompt per model call, only per-message tokens.
- `amicode.reasoning` holds the raw chain-of-thought. Scrub before sharing traces externally.
