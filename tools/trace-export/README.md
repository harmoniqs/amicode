# amicode → Phoenix / Langfuse trace export

Converts an amicode/opencode session (SQLite) into an OTLP / OpenInference trace.

## Files
- `otlp_export.py` — pure-stdlib converter (no pip deps to *produce* the trace)
- `<session>.otlp.json` — OTLP `ExportTraceServiceRequest` JSON, OpenInference attributes
- `<session>.md` — human-readable transcript

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
