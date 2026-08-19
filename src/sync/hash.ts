import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 digest of the given bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
