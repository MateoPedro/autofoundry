import { randomBytes } from "node:crypto";

export type IdPrefix = "cl" | "of" | "co" | "ld" | "tc" | "py" | "dc";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(20);
  let body = "";
  for (const byte of bytes) body += ALPHABET[byte % 32];
  return `${prefix}_${body}`;
}
