// AMICODE: re-export shim (same wildcard-export pattern as amicode-card.tsx).
// Logic lives in ../amicode/receipt.ts and ../amicode/receipt-runs.ts.
export { parseDiffSentinel } from "../amicode/receipt"
export { collapseReceiptRuns, receiptRunKey, type ReceiptCandidate, type ReceiptKey } from "../amicode/receipt-runs"
