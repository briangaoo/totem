// Persistence layer for Cognito tokens. The TokenManager writes the rotated
// access + refresh tokens after every refresh so server restarts pick up the
// latest state without re-bootstrapping (until the refresh token itself
// expires, ~30 days).
//
// Two implementations:
//   - EnvFileTokenStore: writes to a .env file. Used in local dev and on any
//     host that lets you persist a small file (Fly volumes, Railway disks,
//     a VPS). The default.
//   - MemoryTokenStore: no persistence. Used on hosts with read-only file
//     systems (Cloudflare Workers, read-only container disks). Accept that you'll
//     re-bootstrap every 30 days. Opt in via WHOOP_TOKEN_STORE=memory.

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

export interface TokenStore {
  save(updates: { accessToken: string; refreshToken: string }): void;
}

export class EnvFileTokenStore implements TokenStore {
  constructor(private path: string) {}

  save(updates: { accessToken: string; refreshToken: string }): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8").split("\n");
    const upsert = (key: string, value: string): void => {
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      const entry = `${key}=${value}`;
      if (idx >= 0) lines[idx] = entry;
      else lines.push(entry);
    };
    upsert("WHOOP_IOS_BEARER_TOKEN", updates.accessToken);
    upsert("WHOOP_COGNITO_REFRESH_TOKEN", updates.refreshToken);
    // 0600: this file holds the refresh token. mode only applies on create, so
    // chmod too — repairs files written by older versions under a 0644 umask.
    writeFileSync(this.path, lines.join("\n"), { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* best-effort on exotic FS */ }
  }
}

export class MemoryTokenStore implements TokenStore {
  save(_updates: { accessToken: string; refreshToken: string }): void {
    // intentionally no-op; tokens persist only for the lifetime of this process
  }
}
