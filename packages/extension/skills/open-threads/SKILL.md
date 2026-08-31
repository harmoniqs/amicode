---
name: open-threads
description: Sweep recent sessions across the fleet's chat DB, classify their open threads (blocked-on-user / interrupted / parked / awaiting-review / stale), and propose a small consolidated set of fresh sessions to continue the work — spawned on confirmation via the amicode_session tool. Use at session start, on request ("rehash the last two weeks"), or when resuming after time away.
agents: [researcher, director]
surface: public
---

Sweep what the fleet actually did, surface what is still open, and turn the
spawnable parts into a small set of fresh sessions that continue the work.
The unit of resumption is a THEME, not a thread.

## Usage

`/open-threads` — sweep the last 14 days.
`/open-threads <days>` — custom window (e.g. `/open-threads 7`).
`/open-threads --report` — report only; skip the spawn proposal.

The argument is: $ARGUMENTS

## Instructions

### Step 0: Find the chat DB (read-only, always)

The canonical Amicode server aggregates every fleet device's sessions into one
SQLite DB. Resolve it in this order: the `OPENCODE_DB` env if set, else
`~/.local/share/opencode/opencode.db`. On a fleet client, run the sweep ON the
canonical server (see the `fleet` skill for which machine holds the role) —
never copy the DB around. Open it READ-ONLY (the server owns it):

```python
con = sqlite3.connect("file:<db-path>?mode=ro", uri=True)
```

If the DB is locked or missing, report that and stop — do not retry with a
writable connection.

### Step 1: Pull top-level sessions in the window

`window_days` = argument or 14. Run one query for the session list, one for
pending todos. Then, per session, pull the LAST assistant message that carries
text (join `message` → `part`, keep `type == "text"` parts; truncate to ~3 KB).

```python
import sqlite3, datetime, json

con = sqlite3.connect("file:<db-path>?mode=ro", uri=True, timeout=5)
since = (datetime.datetime.now() - datetime.timedelta(days=window_days)).timestamp() * 1000

sessions = con.execute("""
  select id, title, datetime(time_created/1000,'unixepoch'), directory
  from session
  where parent_id is null and time_archived is null and time_created > ?
  order by time_created
""", (since,)).fetchall()

todos = con.execute("""
  select s.title, t.content from todo t join session s on s.id = t.session_id
  where t.status != 'completed' order by t.time_created
""").fetchall()

def last_text(session_id):
    for (mid,) in con.execute("""
      select m.id from message m
      where m.session_id = ? and json_extract(m.data,'$.role')='assistant'
      order by m.time_created desc limit 8
    """, (session_id,)):
        parts = con.execute("select data from part where message_id=? order by time_created", (mid,)).fetchall()
        text = " ".join(json.loads(p[0]).get("text", "")
                        for p in parts if json.loads(p[0]).get("type") == "text")
        if text.strip():
            return text[:3000]
    return ""
```

Filter NOISE titles before classifying — sessions named `Greeting`, `New
session - <ISO>`, `test`, and obvious scratch names carry no threads. Subagent
sessions are already excluded by `parent_id is null`.

### Step 2: Classify every surviving session

Read the last assistant text (the ending usually says it outright: "waiting
on", "next up", "say the word", a mid-action line with no wrap-up) and the
pending todos that name the session. Bucket each thread:

- **BLOCKED-ON-USER** — a decision, key, sign-off, or merge the human owes.
  These are REPORT items, never spawn candidates: a fresh session cannot
  press the button that only the user can press.
- **INTERRUPTED** — the session died mid-action (last text is an unfinished
  step, no verdict, no wrap-up). Prime spawn candidates.
- **PARKED** — ended at a documented next step (campaign ledger "next queue",
  a pre-authorized experiment, a named follow-up). Spawn candidates; the
  parked step is the seed prompt.
- **AWAITING-REVIEW** — green PRs / cards waiting on a human. Report items.
  If a thread names a specific PR, verify its current state with one `gh pr
  view` call before reporting — sessions age faster than GitHub.
- **STALE** — decisions that expired, deadlines long past, month-old
  "awaiting decision" items. Report as "retire unless you say otherwise".

### Step 3: Consolidate into a spawn plan

The smart part is the MERGING. One session per theme, never one per thread:

- Group related threads (same repo, same campaign, same incident) into ONE
  session whose prompt lists every thread it owns.
- Cap the plan at 3-4 sessions total. If more themes survive the sweep, put
  the overflow on the report as "not spooled — say the word".
- Each proposed session needs: a short title (it becomes a tab label), and a
  first prompt that is SELF-CONTAINED — the child starts with zero memory of
  this sweep, so the prompt must carry the pointers verbatim: file paths,
  PR/issue numbers, run dirs, branch names, and the parked next step, in
  plain text. A prompt that says "continue the warp work" is worthless; one
  that says "PR #150 awaits merge review; then Piccolo#321 was interrupted
  mid-debug on a stale precompile at <path>" is a working session.
- `mode` is `fresh` for consolidation spawns. `fork` is the exception — only
  when continuing a thread requires the parent's full transcript rather than
  a state summary, and say so in the plan when you use it.

### Step 4: Report, then confirm before spawning

Deliver the report first: the classified table (thread, session date, what's
open, bucket), BLOCKED-ON-USER and AWAITING-REVIEW items called out as
explicitly yours-not-spawnable, and the STALE retire list. Then present the
spawn plan and ask via the `question` tool (`multiple: true`, one option per
proposed session, plus a "spawn nothing" option). NEVER spawn without an
explicit selection — every spawned session starts its first turn immediately
on the user's model budget, and the tool hard-caps at 4 per call anyway.

### Step 5: Spawn

For each confirmed theme, one `amicode_session` call: `prompt` = the
self-contained seed from Step 3, `title` = the tab label, `count: 1`. The
parent pane auto-opens the children as background tabs.

**If the `amicode_session` tool is not available** (not yet deployed on this
install, or an older extension): say so plainly, deliver the report, and
offer to run the highest-priority theme inline in THIS session instead — do
not pretend the spawn happened.

### Report format

Skimmable, grouped by bucket, newest first. Thread lines carry: date, session
title, one line on what's open. The spawn plan is a numbered list of proposed
sessions with their seed-prompt summaries — the full prompts are what you
pass to the tool, not what you print in chat.
