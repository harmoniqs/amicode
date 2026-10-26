import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ExhaustedReceipt } from "../../src/session/exhausted-receipt"

// #1905 (A13a): receipt shape is derived from tool parts, never from prose.

function tool(messageID: string, name: string, state: Record<string, unknown>) {
  return { id: `prt_${messageID}_${name}`, messageID, sessionID: "ses_child", type: "tool", callID: "c", tool: name, state }
}

function message(id: string, parts: unknown[], error?: SessionV1.Assistant["error"]) {
  return {
    info: { id, role: "assistant", sessionID: "ses_child", ...(error ? { error } : {}) },
    parts,
  } as unknown as SessionV1.WithParts
}

const done = (input: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  status: "completed",
  input,
  output: "",
  title: "",
  metadata,
  time: { start: 0, end: 1 },
})

describe("ExhaustedReceipt", () => {
  test("files_touched collects edit/write/apply_patch paths in order, de-duplicated, completed only", () => {
    const receipt = ExhaustedReceipt.build({
      taskID: "ses_child",
      steps: 3,
      messages: [
        message("msg_1", [
          tool("msg_1", "write", done({ filePath: "/w/a.ts" })),
          tool("msg_1", "read", done({ filePath: "/w/r.ts" })),
          tool("msg_1", "edit", { status: "error", input: { filePath: "/w/failed.ts" }, error: "no match", time: {} }),
        ]),
        message("msg_2", [
          tool(
            "msg_2",
            "apply_patch",
            done({ patchText: "..." }, { files: [{ filePath: "/w/b.ts" }, { filePath: "/w/c.ts", movePath: "/w/d.ts" }] }),
          ),
          tool("msg_2", "edit", done({ filePath: "/w/a.ts" })),
        ]),
      ],
    })
    expect(receipt.files_touched).toEqual(["/w/a.ts", "/w/b.ts", "/w/c.ts", "/w/d.ts"])
    expect(receipt.last_error).toBe("edit: no match")
    expect(receipt.last_todo).toBeUndefined()
  })

  test("last_todo is the final todowrite state; last_error prefers the newest failure", () => {
    const receipt = ExhaustedReceipt.build({
      taskID: "ses_child",
      steps: 2,
      messages: [
        message("msg_1", [
          tool("msg_1", "todowrite", done({ todos: [{ content: "old", status: "pending", priority: "low" }] })),
          tool("msg_1", "bash", { status: "error", input: {}, error: "exit 1", time: {} }),
        ]),
        message("msg_2", [tool("msg_2", "todowrite", done({ todos: [{ content: "new", status: "completed", priority: "high" }] }))], {
          name: "APIError",
          data: { message: "Too Many Requests", isRetryable: true },
        } as SessionV1.Assistant["error"]),
      ],
    })
    expect(receipt.last_todo).toEqual([{ content: "new", status: "completed", priority: "high" }])
    expect(receipt.last_error).toBe("APIError: Too Many Requests")
  })

  test("render → parse round-trips and ignores text without a receipt", () => {
    const receipt = ExhaustedReceipt.build({ taskID: "ses_child", steps: 4, messages: [] })
    expect(receipt).toEqual({ exhausted: true, steps: 4, files_touched: [], task_id: "ses_child" })
    expect(ExhaustedReceipt.parse(`prose\n\n${ExhaustedReceipt.render(receipt)}\n</task_result>`)).toEqual(receipt)
    expect(ExhaustedReceipt.parse("plain prose, no receipt")).toBeUndefined()
  })

  test("take consumes a mark exactly once", () => {
    ExhaustedReceipt.mark("msg_take", 7)
    expect(ExhaustedReceipt.take("msg_take")).toBe(7)
    expect(ExhaustedReceipt.take("msg_take")).toBeUndefined()
  })
})
