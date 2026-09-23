import { describe, expect, test, vi } from "bun:test"
import { loadMirror, saveMirror, type MirrorRecord } from "./session-mirror"

type Transaction = {
  mode: IDBTransactionMode
  operations: string[]
}

function createIndexedDBHarness() {
  const records = new Map<string, unknown>()
  const transactions: Transaction[] = []
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: (_store: string, mode: IDBTransactionMode) => {
      const transaction: Transaction = { mode, operations: [] }
      transactions.push(transaction)
      const tx = {} as IDBTransaction
      const complete = () => queueMicrotask(() => tx.oncomplete?.(new Event("complete")))
      const store = {
        put: (value: unknown, key: string) => {
          transaction.operations.push("put")
          records.set(key, value)
          const request = {} as IDBRequest
          queueMicrotask(() => {
            request.onsuccess?.(new Event("success"))
            complete()
          })
          return request
        },
        get: (key: string) => {
          transaction.operations.push("get")
          const request = { result: records.get(key) } as IDBRequest
          queueMicrotask(() => request.onsuccess?.(new Event("success")))
          return request
        },
        openCursor: () => {
          transaction.operations.push("cursor")
          const entries = [...records.entries()]
          let index = 0
          const request = {
            result: null as IDBCursorWithValue | null,
            onsuccess: undefined as ((event: Event) => unknown) | undefined,
          }
          const next = () => {
            const entry = entries[index]
            request.result = entry
              ? ({ key: entry[0], value: entry[1], continue: () => {
                  index += 1
                  queueMicrotask(next)
                } } as unknown as IDBCursorWithValue)
              : null
            request.onsuccess?.(new Event("success"))
            if (!entry) complete()
          }
          queueMicrotask(next)
          return request as unknown as IDBRequest<IDBCursorWithValue | null>
        },
        delete: (key: string) => {
          transaction.operations.push("delete")
          records.delete(key)
          return {} as IDBRequest
        },
      } as unknown as IDBObjectStore
      tx.objectStore = () => store
      return tx
    },
  } as unknown as IDBDatabase

  return {
    transactions,
    indexedDB: {
      open: () => {
        const request = { result: db } as IDBOpenDBRequest
        queueMicrotask(() => {
          request.onupgradeneeded?.(new Event("upgradeneeded") as IDBVersionChangeEvent)
          request.onsuccess?.(new Event("success"))
        })
        return request
      },
    } as unknown as IDBFactory,
  }
}

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

const record = (): Omit<MirrorRecord, "v" | "savedAt"> => ({
  info: undefined,
  messages: [],
  source: [],
})

describe("session mirror pruning", () => {
  test("defers one full-store prune per scope, preserves post-save reads, and schedules scopes independently", async () => {
    vi.useFakeTimers()
    const original = globalThis.indexedDB
    const harness = createIndexedDBHarness()
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: harness.indexedDB })

    try {
      saveMirror("scope-a", "one", record())
      saveMirror("scope-a", "two", record())
      saveMirror("scope-a", "three", record())
      vi.advanceTimersByTime(1_000)
      await settle()

      await loadMirror("scope-a", "one")
      await settle()
      expect(harness.transactions.filter((item) => item.operations.includes("cursor"))).toHaveLength(0)
      expect(harness.transactions.at(-1)?.operations).toEqual(["get"])

      saveMirror("scope-b", "one", record())
      vi.advanceTimersByTime(1_000)
      await settle()

      vi.advanceTimersByTime(59_000)
      await settle()
      expect(harness.transactions.filter((item) => item.operations.includes("cursor"))).toHaveLength(1)

      vi.advanceTimersByTime(1_000)
      await settle()
      expect(harness.transactions.filter((item) => item.operations.includes("cursor"))).toHaveLength(2)
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: original })
      vi.useRealTimers()
    }
  })
})
