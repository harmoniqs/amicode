// Type declarations for the ESM fetch_opencode module (scripts/fetch_opencode.mjs).
// Consumed by src/rebuild/main_source_resolver.ts via dynamic import.

export function loadManifest(root?: string): Record<string, unknown>;
export function resolvePlatform(manifest: Record<string, unknown>, flag?: string): string;
export function releaseCoords(manifest: Record<string, unknown>): {
  repo: string;
  tag: string;
  isFork: boolean;
  readonly private: boolean;
};
export function assetUrl(manifest: Record<string, unknown>, platform: string): string;
export function assertReleaseChannel(
  coords: { repo: string; tag: string },
  channel: string,
  api?: (repo: string, path: string, jq: string) => string,
): Promise<void>;
export const sha256: (buf: Buffer) => string;

export function classifyDownloadError(err: unknown): "transient" | "permanent" | "auth";
export function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: {
    maxAttempts?: number;
    baseDelay?: number;
    factor?: number;
    isPermanent?: (err: unknown) => boolean;
    onRetry?: (attempt: number, err: unknown) => void;
  },
): Promise<T>;

export function fetchOpencode(opts?: {
  root?: string;
  platform?: string;
  download?: (url: string) => Promise<Buffer>;
  ghApi?: (repo: string, path: string, jq: string) => string;
  mode?: "release" | "local";
  localDir?: string;
  anyRef?: boolean;
  noBuild?: boolean;
  build?: (dir: string, version: string) => void;
  retryOpts?: { maxAttempts?: number; baseDelay?: number; factor?: number };
}): Promise<{ skipped: boolean; path: string; source: string }>;
