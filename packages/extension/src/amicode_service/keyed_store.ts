// SHARED KEYED-0600-STORE PRIMITIVE (#1438, ADR 0032 §D1).
//
// hub_credential.ts, attachment_credential.ts, and this slice's reader
// peer-token store all want the SAME shape: a small map of entries keyed by
// `machine_id`, under a named collection key, atomically written 0600, with
// unknown top-level keys preserved on rewrite (F4 bidirectional courtesy) and
// a tolerant read that degrades a corrupt/absent file to an empty collection
// (never a throw, never a fabricated credential).
//
// ADR 0032 §D1 explicitly asks to FACTOR this rather than fork a third copy —
// the reader peer-store's shape is byte-identical to attachment_credential.ts:119,
// so both ride this primitive. hub_credential.ts is a single flat credential
// (different shape) and stays as-is.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { atomicWriteFileSync } from "./credentials";

interface KeyedDoc {
  store_version?: number;
  [key: string]: unknown;
}

/** Tolerant whole-file read — an absent/corrupt/non-object file is {} (never a
 *  throw), exactly like attachment_credential.ts's readStoreDoc. */
function readDoc(file: string): KeyedDoc {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as KeyedDoc;
}

function collectionOf(doc: KeyedDoc, collectionKey: string): Record<string, unknown> {
  const c = doc[collectionKey];
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

/** Read ONE named collection's map (e.g. "peers", "issued"). Absent/corrupt →
 *  {}. */
export function readKeyedCollection(file: string, collectionKey: string): Record<string, unknown> {
  return collectionOf(readDoc(file), collectionKey);
}

/** Upsert ONE entry keyed by `id` under `collectionKey`. Every OTHER entry, and
 *  every unknown top-level key, is preserved untouched. Atomic 0600 via the
 *  shared credentials writer. */
export function upsertKeyedEntry(
  file: string,
  collectionKey: string,
  id: string,
  value: unknown,
  storeVersion: number,
): void {
  const doc = readDoc(file);
  const collection = { ...collectionOf(doc, collectionKey), [id]: value };
  const out: KeyedDoc = { ...doc, store_version: storeVersion, [collectionKey]: collection };
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Delete ONE entry (the revoke / detach counterpart). An absent key, or an
 *  absent store, is an idempotent no-op. */
export function deleteKeyedEntry(file: string, collectionKey: string, id: string, storeVersion: number): void {
  const doc = readDoc(file);
  const collection = collectionOf(doc, collectionKey);
  if (!(id in collection)) return;
  const remaining = { ...collection };
  delete remaining[id];
  const out: KeyedDoc = { ...doc, store_version: storeVersion, [collectionKey]: remaining };
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Remove the entire store file; absent is a no-op. */
export function clearKeyedStoreFile(file: string): void {
  rmSync(file, { force: true });
}
