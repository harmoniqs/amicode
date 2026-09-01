// Typed surface of scripts/validate_bridge_replay.mjs for the test suite (the
// amico-run tsconfig includes test/, unlike the extension package's — hence
// this declaration rather than an untyped import).

export type BridgeRecordKind = "amicode-run" | "strumento-task";

export interface BridgeValidation {
  ok: boolean;
  kind: BridgeRecordKind;
  errors: string[];
}

export function defaultFixtureDirs(): { kind: BridgeRecordKind; dir: string }[];

export function inferRecordKind(dir: string): BridgeRecordKind | undefined;

export function validateBridgeRecord(dir: string, kind?: BridgeRecordKind): BridgeValidation;

export function main(argv: string[]): Promise<number>;
