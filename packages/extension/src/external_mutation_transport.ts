/**
 * Extension-local transport for the paired OpenCode external-diff v1 routes.
 *
 * The released generated SDK has not yet been pinned into this extension. Keep
 * this deliberately small adapter at the host boundary and replace it with the
 * generated session client once that pin lands. Reservation capabilities never
 * cross into a webview.
 */

export interface ExternalReservationEndpoint {
  reference: string;
  capability: string;
  revision: number;
}

export interface ExternalReservation {
  id: string;
  expiresAt: number;
  endpoints: ExternalReservationEndpoint[];
}

export interface AssessedExternalReference {
  reference: string;
  file: string;
}

export interface AssessedExternalDetail {
  revision: number;
  assessments: AssessedExternalReference[];
}

export interface ExternalMutationTransportOptions {
  url: string;
  authorization: string;
  fetch?: typeof globalThis.fetch;
}

function isReservation(value: unknown): value is ExternalReservation {
  if (!value || typeof value !== "object") return false;
  const reservation = value as Partial<ExternalReservation>;
  return typeof reservation.id === "string"
    && Number.isFinite(reservation.expiresAt)
    && Array.isArray(reservation.endpoints)
    && reservation.endpoints.every((endpoint) =>
      !!endpoint
      && typeof endpoint.reference === "string"
      && typeof endpoint.capability === "string"
      && Number.isFinite(endpoint.revision),
    );
}

/** Authenticated v1 reservation transport; all failures degrade to untracked. */
export class ExternalMutationTransport {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: ExternalMutationTransportOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async prepare(sessionID: string, files: string[]): Promise<ExternalReservation | undefined> {
    const response = await this.post(sessionID, "prepare", { version: 1, files });
    if (!response || response.version !== 1 || !isReservation(response.reservation)) return;
    return response.reservation;
  }

  async commit(sessionID: string, reservation: ExternalReservation): Promise<boolean> {
    const response = await this.post(sessionID, "commit", { version: 1, reservation });
    return response?.version === 1 && response.committed === true;
  }

  async abort(sessionID: string, reservation: ExternalReservation): Promise<boolean> {
    const response = await this.post(sessionID, "abort", { version: 1, reservation });
    return response?.version === 1 && response.aborted === true;
  }

  /** Host-only detail fetch used to register canonical file watchers. */
  async assessed(sessionID: string): Promise<AssessedExternalDetail | undefined> {
    try {
      const url = new URL(`/session/${encodeURIComponent(sessionID)}/diff/assessed`, this.options.url);
      url.searchParams.set("patch", "false");
      const response = await this.fetch(url.toString(), {
        headers: { Authorization: this.options.authorization },
      });
      if (!response.ok) return;
      const value = await response.json() as { version?: unknown; revision?: unknown; assessments?: unknown };
      if (value.version !== 1 || typeof value.revision !== "number" || !Number.isFinite(value.revision) || !Array.isArray(value.assessments)) return;
      const assessments = value.assessments.flatMap((assessment): AssessedExternalReference[] => {
        if (!assessment || typeof assessment !== "object") return [];
        const { reference, file } = assessment as { reference?: unknown; file?: unknown };
        return typeof reference === "string" && typeof file === "string" ? [{ reference, file }] : [];
      });
      return { revision: value.revision, assessments };
    } catch {
      return;
    }
  }

  private async post(
    sessionID: string,
    action: "prepare" | "commit" | "abort",
    body: object,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const url = new URL(
        `/session/${encodeURIComponent(sessionID)}/external-diff/reservations/${action}`,
        this.options.url,
      );
      const response = await this.fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.options.authorization,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) return;
      const value = await response.json();
      return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
    } catch {
      return;
    }
  }
}
