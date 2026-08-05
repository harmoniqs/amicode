// `amico handoff` — pure core (spec-20260804-211500; feeds the memory card
// `feedback_repo_handoff_access.md`: a handoff is not done when the repo is pushed,
// it is done when the recipient can READ it). No I/O here: permission validation,
// receipt construction, access-state interpretation, exit-code arithmetic — all
// pure so the verb layer stays a thin arg/exec/JSON shell and tests never touch
// the network.
//
// The access semantics this encodes (GitHub):
//   PUT collaborator → 204 means the user has access NOW (org member or already a
//     collaborator); 201 means GitHub emailed an invitation and the repo STILL 404s
//     until they accept — "pending-acceptance". Treating 201 as success is exactly
//     the bug this verb exists to prevent.

export const PERMISSIONS = ["pull", "push", "maintain", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Effective access to a repo for one handle. `none` = no record (check only). */
export type Access = "immediate" | "pending-acceptance" | "none" | "failed";

export interface HandleReceipt {
  handle: string;
  permission?: Permission; // grant only
  access: Access;
  detail: string; // one line, human-readable reason
}

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}

/** `<org>/<repo>` shape — used to fail usage errors with 64, never as a security check. */
export function isRepoSlug(s: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}

/** Exit-code ordering: any failure → 2; else any pending/none → 1; else 0. */
export function exitCodeFor(receipts: HandleReceipt[]): number {
  if (receipts.some((r) => r.access === "failed")) return 2;
  if (receipts.some((r) => r.access === "pending-acceptance" || r.access === "none")) return 1;
  return 0;
}

/** Build the grant receipt for one handle from its PUT status + verify state. */
export function grantReceipt(
  handle: string,
  permission: Permission,
  putStatus: number | undefined,
  verify: { collaborator: boolean; invited: boolean },
  stderr?: string,
): HandleReceipt {
  if (putStatus === 204) {
    return {
      handle,
      permission,
      access: verify.collaborator ? "immediate" : "failed",
      detail: verify.collaborator
        ? "access now (org member or already a collaborator)"
        : "PUT returned 204 but the collaborator record does not verify — API state inconsistent",
    };
  }
  if (putStatus === 201) {
    return {
      handle,
      permission,
      access: "pending-acceptance",
      detail: "GitHub emailed an invitation — the repo 404s for them UNTIL ACCEPTED; do not announce yet",
    };
  }
  return {
    handle,
    permission,
    access: "failed",
    detail: stderr?.trim() || `PUT failed (HTTP ${putStatus ?? "unknown"})`,
  };
}

/** Build the check receipt for one handle from the read state. */
export function checkReceipt(
  handle: string,
  state: { collaborator: boolean; invited: boolean },
  stderr?: string,
): HandleReceipt {
  if (state.collaborator) {
    return { handle, access: "immediate", detail: "can read the repo now" };
  }
  if (state.invited) {
    return { handle, access: "pending-acceptance", detail: "invitation sent, not yet accepted" };
  }
  if (stderr !== undefined) {
    return { handle, access: "failed", detail: stderr.trim() };
  }
  return { handle, access: "none", detail: "no collaborator record and no pending invitation" };
}

/** Parse the HTTP status line out of `gh api -i` stdout; undefined if absent. */
export function httpStatus(ghOutput: string): number | undefined {
  const m = ghOutput.match(/^HTTP\/\S+\s+(\d{3})/m);
  return m ? Number(m[1]) : undefined;
}

/** Paste-ready handoff line — only when every handle is immediate (else undefined). */
export function handoffLine(repo: string, receipts: HandleReceipt[]): string | undefined {
  if (receipts.length === 0 || exitCodeFor(receipts) !== 0) return undefined;
  const names = receipts.map((r) => `@${r.handle}`).join(", ");
  const perm = receipts[0]?.permission;
  return `handoff ready: https://github.com/${repo} is readable by ${names}` + (perm ? ` (${perm})` : "");
}
