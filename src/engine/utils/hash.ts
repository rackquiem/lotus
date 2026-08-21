import { createHash } from "crypto";

export function sha256Hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string): string {
  return sha256Hash(input).slice(0, 16);
}
