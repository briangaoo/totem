// Shared CLI primitives: colors, subprocess runner, HTTP ping, interactive
// prompts, and small helpers used by both the command dispatcher (index.ts)
// and the guided setup flows (setup.ts).
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  brand: "\x1b[38;2;225;225;225m",
  brandDim: "\x1b[38;2;150;150;150m",
  gray: "\x1b[38;2;120;120;120m",
  white: "\x1b[97m",
  green: "\x1b[92m",
  red: "\x1b[91m",
  yellow: "\x1b[93m",
  cyan: "\x1b[96m",
};
function wrap(code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}
export const c = {
  brand: (s: string) => wrap(ANSI.brand, s),
  brandDim: (s: string) => wrap(ANSI.brandDim, s),
  gray: (s: string) => wrap(ANSI.gray, s),
  white: (s: string) => wrap(ANSI.white, s),
  green: (s: string) => wrap(ANSI.green, s),
  red: (s: string) => wrap(ANSI.red, s),
  yellow: (s: string) => wrap(ANSI.yellow, s),
  cyan: (s: string) => wrap(ANSI.cyan, s),
  bold: (s: string) => wrap(ANSI.bold, s),
  dim: (s: string) => wrap(ANSI.dim, s),
};

// Spawn a command, inheriting stdio. Resolves with the exit code.
export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(c.red(`\nKilled by signal ${signal}`));
        res(128);
        return;
      }
      res(code ?? 1);
    });
    child.on("error", (err) => {
      console.error(c.red("Failed to spawn:"), (err as Error).message);
      res(1);
    });
  });
}

// Run a command and capture stdout (for parsing CLI output like a deploy URL).
export function capture(cmd: string, args: string[], opts: SpawnOptions = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Is a CLI tool on PATH? Uses which/where (real executables) rather than the
// `command -v` shell builtin, so we avoid `shell: true` — which both triggers
// Node 25's DEP0190 warning and is an injection risk.
export function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
  return (r.status ?? 1) === 0 && (r.stdout ?? "").trim().length > 0;
}

// 256-bit random hex token (for MCP_AUTH_TOKEN / signing secret).
export function genToken(): string {
  return randomBytes(32).toString("hex");
}

// Cryptographically-random password. Rejection sampling over an unambiguous
// alphabet (no 0/O/1/l/I) plus symbols for entropy — safe to read/retype.
export function genPassword(len = 18): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // reject modulo bias
  let out = "";
  while (out.length < len) {
    const b = randomBytes(1)[0]!;
    if (b < max) out += alphabet[b % alphabet.length];
  }
  return out;
}

// Best-effort copy to the OS clipboard. Returns true on success, false if no
// clipboard tool is available (never throws).
export function copyToClipboard(text: string): boolean {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["pbcopy", []]
    : process.platform === "win32" ? ["clip", []]
    : ["xclip", ["-selection", "clipboard"]];
  try {
    const r = spawnSync(cmd, args, { input: text });
    return (r.status ?? 1) === 0;
  } catch {
    return false;
  }
}

// Run a bundled script resiliently. A published install (`npm install -g`)
// ships the compiled `dist/*.js` and only runtime deps — no `tsx`/`typescript`.
// A dev checkout has `tsx` + the TypeScript source. Prefer whichever fits:
// dist+node by default (works everywhere), source+tsx when `preferSource` is set
// (live dev, picks up edits without a rebuild). `relNoExt` is relative to src/
// or dist/ without extension, e.g. "scripts/cognito_bootstrap" or "server".
export function runScript(
  root: string,
  relNoExt: string,
  args: string[] = [],
  opts: { preferSource?: boolean } & SpawnOptions = {},
): Promise<number> {
  const { preferSource = false, ...spawnOpts } = opts;
  const distJs = resolve(root, "dist", `${relNoExt}.js`);
  const srcTs = resolve(root, "src", `${relNoExt}.ts`);
  const tsx = resolve(root, "node_modules", ".bin", "tsx");
  const viaDist: [string, string] = [process.execPath, distJs];
  const viaTsx: [string, string] = [tsx, srcTs];
  const order = preferSource ? [viaTsx, viaDist] : [viaDist, viaTsx];
  for (const [bin, script] of order) {
    const binOk = bin === process.execPath || existsSync(bin);
    if (binOk && existsSync(script)) return run(bin, [script, ...args], { cwd: root, ...spawnOpts });
  }
  console.error(c.red(`Can't run ${relNoExt}: need either a built dist/ or the tsx dev dependency.`));
  console.error(c.gray("Run ") + c.bold("npm install && whoop-mcp build") + c.gray(" in a source checkout, or reinstall the published package."));
  return Promise.resolve(1);
}

// Ensure a CLI tool is on PATH; if not, offer to install it (with permission).
// Tries brew → npm → install script, in that order, based on what's available.
// Note: a freshly installed tool often isn't on this process's PATH yet, so we
// re-check and, if still missing, tell the user to re-run in a new shell.
export async function ensureCli(
  name: string,
  opts: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string },
): Promise<boolean> {
  if (commandExists(name)) return true;
  console.log(c.yellow(`  ${name} isn't installed.`));
  // Collect the install methods that are actually available and try them in
  // order (brew → npm → script), falling THROUGH if one fails (e.g. a brew
  // formula doesn't exist) instead of giving up after the first.
  const methods: Array<[string, string[]]> = [];
  if (opts.brewPkg && commandExists("brew")) methods.push(["brew", ["install", opts.brewPkg]]);
  if (opts.npmPkg && commandExists("npm")) methods.push(["npm", ["install", "-g", opts.npmPkg]]);
  if (opts.scriptUrl) methods.push(["sh", ["-c", `curl -fsSL ${opts.scriptUrl} | sh`]]);
  if (methods.length === 0) {
    console.log(c.gray(`  Install it manually: ${opts.manualHint}`));
    return false;
  }
  for (const [cmd, args] of methods) {
    console.log(c.gray(`    $ ${cmd} ${args.join(" ")}`));
    if (!(await promptYesNo(`Install ${name} via \`${cmd}\`?`, true))) continue;
    if ((await run(cmd, args)) === 0 && commandExists(name)) return true;
    console.log(c.yellow(`  ${cmd} didn't get ${name} working${methods.length > 1 ? " — trying the next method" : ""}.`));
  }
  if (!commandExists(name)) {
    console.log(c.yellow(`  ${name} still isn't on this shell's PATH.`));
    console.log(c.gray(`  ${opts.manualHint} — or open a new terminal and re-run.`));
    return false;
  }
  return true;
}

// Open a URL in the default browser, cross-platform. Best-effort, never throws.
export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawnSync(cmd, args, { stdio: "ignore" }); } catch { /* best-effort */ }
}

// GET a URL, resolve with {status, body}. Used for health + OAuth metadata checks.
export function httpGet(url: string, timeoutMs = 12_000): Promise<{ status: number; body: string }> {
  return new Promise((res) => {
    const u = new URL(url);
    const req = httpsRequest(
      { method: "GET", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { "user-agent": "whoop-mcp-setup" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (ch: string) => (body += ch));
        response.on("end", () => res({ status: response.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); res({ status: 0, body: "" }); });
    req.on("error", () => res({ status: 0, body: "" }));
    req.end();
  });
}

export function ping(url: string, timeoutMs = 10_000): Promise<number> {
  return httpGet(url, timeoutMs).then((r) => {
    const ok = r.status >= 200 && r.status < 300;
    const label = ok ? c.green(`✓ ${r.status}`) : c.red(`✗ ${r.status || "timeout"}`);
    const preview = r.body.length > 100 ? r.body.slice(0, 97) + "..." : r.body;
    console.log(`${label}  ${url}  ${c.gray(preview.replace(/\s+/g, " ").trim())}`);
    return ok ? 0 : 1;
  });
}

// ── interactive prompts ─────────────────────────────────────────────────────
// A fresh readline per question. Long-lived readlines break when a subprocess
// in between (e.g. the build step) inherits stdin, so we open/close per ask.
// On EOF (piped input) the question resolves empty instead of throwing.
async function ask(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

// Kept for API compatibility; no-op now that prompts are per-call.
export function closePrompts(): void {}

export async function prompt(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? c.gray(` [${fallback}]`) : "";
  const answer = await ask(`${c.cyan("?")} ${question}${suffix}: `);
  return answer || fallback;
}

export async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await ask(`${c.cyan("?")} ${question} ${c.gray(`(${hint})`)}: `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// Numbered menu. Returns the 0-based index of the choice.
export async function promptChoice(question: string, choices: string[]): Promise<number> {
  console.log(`${c.cyan("?")} ${question}`);
  choices.forEach((ch, i) => console.log(`  ${c.bold(String(i + 1))}. ${ch}`));
  for (let attempts = 0; attempts < 100; attempts++) {
    const raw = await ask(`  ${c.gray("enter a number")}: `);
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
    if (raw === "") return 0; // EOF / piped input → first choice (safe default)
    console.log(c.red(`  Please enter 1-${choices.length}.`));
  }
  return 0;
}

// Section header for the guided flows.
export function step(n: number, total: number, title: string): void {
  console.log("");
  console.log(`${c.brand(`[${n}/${total}]`)} ${c.bold(title)}`);
}
