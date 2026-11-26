// Local dashboard authentication: a random access token (stored 0600 in the QuantForge home) is exchanged at
// login for a session cookie (HttpOnly, SameSite=Strict). Login attempts and API requests are rate-limited
// per client address. Tokens are compared in constant time.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readPrivate, writePrivate } from "../../store/private-file.js";
import { registerSecret } from "../core/logger.js";

export async function loadOrCreateToken(file: string): Promise<{ token: string; created: boolean }> {
  const existing = (await readPrivate(file))?.trim();
  if (existing && existing.length >= 24) {
    registerSecret(existing);
    return { token: existing, created: false };
  }
  const token = randomBytes(24).toString("base64url");
  await writePrivate(file, `${token}\n`);
  registerSecret(token);
  return { token, created: true };
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export class SessionStore {
  private sessions = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}

  create(): string {
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, Date.now() + this.ttlMs);
    if (this.sessions.size > 50) {
      const now = Date.now();
      for (const [k, exp] of this.sessions) if (exp < now) this.sessions.delete(k);
    }
    return id;
  }

  valid(id: string | undefined): boolean {
    if (!id) return false;
    const exp = this.sessions.get(id);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  revoke(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

/** Fixed-window rate limiter keyed by client. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start > this.windowMs) {
      this.hits.set(key, { start: now, n: 1 });
      if (this.hits.size > 1000) this.hits.clear();
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
