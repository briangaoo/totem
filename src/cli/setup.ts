// Guided setup flows: `whoop-mcp cloud` (server-hosted, OAuth, recommended) and
// `whoop-mcp local` (stdio on this machine). These are the headline commands.
//
// Reality of multi-platform automation: only Fly is live-tested by the author.
// Railway / Cloud Run run their documented CLI commands but, because
// their deploy-URL output formats vary and I can't verify them, the flow asks
// you to paste the resulting URL rather than scraping it. Custom is a printed
// guide for any other platform or your own server. Either way it's one command
// that walks you to a working, Claude-connected deployment.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  c, run, capture, commandExists, genToken, genPassword, copyToClipboard, httpGet,
  prompt, promptYesNo, promptChoice, step, closePrompts,
  runScript, ensureCli, openUrl,
} from "./ui.js";

// ── .env helpers ────────────────────────────────────────────────────────────
function envPath(root: string): string {
  return resolve(root, ".env");
}
function readEnv(root: string): Record<string, string> {
  const p = envPath(root);
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}
function upsertEnv(root: string, updates: Record<string, string>): void {
  const p = envPath(root);
  const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(p, lines.join("\n"));
}

// Record of where we deployed, so `refresh` can push to the right place later.
interface DeployRecord {
  platform: string;
  app: string;
  url: string;
}
function writeDeployRecord(root: string, rec: DeployRecord): void {
  writeFileSync(resolve(root, ".whoop-mcp-deploy.json"), JSON.stringify(rec, null, 2));
}

// ── shared: ensure dependencies are installed (offer to run npm install) ─────
// A published `npm install -g` already has node_modules; a fresh git checkout
// that never ran `npm install` does not — without it the build + auth steps
// would just error out. This keeps the flow zero-setup.
async function ensureDeps(root: string): Promise<boolean> {
  if (existsSync(resolve(root, "node_modules"))) return true;
  console.log(c.yellow("  Dependencies aren't installed yet."));
  if (!(await promptYesNo("Run `npm install` now?", true))) {
    console.log(c.red("  Can't continue without dependencies."));
    return false;
  }
  return (await run("npm", ["install"], { cwd: root })) === 0;
}

// ── shared: ensure we have Whoop tokens (run auth if not) ────────────────────
async function ensureAuth(root: string): Promise<boolean> {
  const env = readEnv(root);
  if (env.WHOOP_IOS_BEARER_TOKEN && env.WHOOP_COGNITO_REFRESH_TOKEN) {
    const reuse = await promptYesNo("Found existing Whoop tokens in .env. Reuse them?", true);
    if (reuse) return true;
  }
  // Need email + password in .env for the bootstrap script.
  if (!env.WHOOP_EMAIL) {
    const email = await prompt("Your Whoop account email");
    if (!email) { console.log(c.red("Email required.")); return false; }
    upsertEnv(root, { WHOOP_EMAIL: email });
  }
  if (!readEnv(root).WHOOP_PASSWORD) {
    const pw = await prompt("Your Whoop account password (stored only in local .env, used once)");
    if (!pw) { console.log(c.red("Password required.")); return false; }
    upsertEnv(root, { WHOOP_PASSWORD: pw });
  }
  console.log(c.gray("Authenticating with Whoop (you'll get an SMS code if your account has MFA)…"));
  // closePrompts so the bootstrap script owns stdin for its own SMS prompt.
  closePrompts();
  // runScript prefers the compiled dist/ (works in a published install with no
  // tsx), falling back to tsx on source for a dev checkout.
  const code = await runScript(root, "scripts/cognito_bootstrap");
  if (code !== 0) { console.log(c.red("Auth failed.")); return false; }
  return true;
}

// ── prerequisites (guided preflight, consistent across every path) ────────────
// Each prerequisite is shown: already-satisfied ones are ✓'d and skipped; the
// rest are guided to completion. The whole list always runs, so you see exactly
// what was already set up vs. what we just did, then it returns to the flow.
interface Prereq {
  label: string;
  check: () => boolean | Promise<boolean>;
  ensure: () => Promise<boolean>;
}

async function preflight(prereqs: Prereq[]): Promise<boolean> {
  for (const p of prereqs) {
    if (await p.check()) { console.log(c.green(`  ✓ ${p.label}`)); continue; }
    console.log(c.yellow(`  • ${p.label} — setting it up`));
    if (!(await p.ensure())) { console.log(c.red(`  ✗ ${p.label} — couldn't complete; fix the above + re-run.`)); return false; }
    console.log(c.green(`  ✓ ${p.label}`));
  }
  return true;
}

// shared prerequisites ────────────────────────────────────────────────────────
const nodePrereq: Prereq = {
  label: `Node.js ≥ 24 (have ${process.version})`,
  check: () => Number(process.versions.node.split(".")[0] || "0") >= 24,
  ensure: async () => {
    console.log(c.gray("  Needs Node 24+. Upgrade (https://nodejs.org or `brew upgrade node`) and re-run."));
    return false;
  },
};
function depsPrereq(root: string): Prereq {
  return { label: "npm dependencies", check: () => existsSync(resolve(root, "node_modules")), ensure: () => ensureDeps(root) };
}
function buildPrereq(root: string): Prereq {
  return {
    label: "server built (dist/)",
    check: () => existsSync(resolve(root, "dist", "server.js")),
    ensure: async () => {
      const tsc = resolve(root, "node_modules", ".bin", "tsc");
      if (!existsSync(tsc)) { console.log(c.gray("  No TypeScript compiler — run `npm install`, then re-run.")); return false; }
      return (await run(process.execPath, [tsc], { cwd: root })) === 0;
    },
  };
}

// host-CLI prerequisite (install on demand via ensureCli) ──────────────────────
function cliPrereq(label: string, name: string, install: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string }): Prereq {
  return { label, check: () => commandExists(name), ensure: () => ensureCli(name, install) };
}

const flyPrereqs: Prereq[] = [
  {
    label: "Fly CLI (flyctl)",
    check: () => commandExists("fly") || commandExists("flyctl"),
    ensure: () => ensureCli("flyctl", { brewPkg: "flyctl", scriptUrl: "https://fly.io/install.sh", manualHint: "brew install flyctl (or: curl -L https://fly.io/install.sh | sh)" }),
  },
  {
    label: "logged into Fly",
    check: () => capture(commandExists("fly") ? "fly" : "flyctl", ["auth", "whoami"]).code === 0,
    ensure: async () => (await run(commandExists("fly") ? "fly" : "flyctl", ["auth", "login"])) === 0,
  },
];

const railwayPrereqs: Prereq[] = [
  cliPrereq("Railway CLI", "railway", { npmPkg: "@railway/cli", brewPkg: "railway", manualHint: "npm i -g @railway/cli (or: brew install railway)" }),
  {
    label: "logged into Railway",
    check: () => capture("railway", ["whoami"]).code === 0,
    ensure: async () => (await run("railway", ["login"])) === 0,
  },
];

// gcloud needs more than a CLI: install → auth → project → billing.
async function selectOrCreateGcpProject(): Promise<boolean> {
  const existing = capture("gcloud", ["projects", "list", "--format=value(projectId)"]).stdout.trim().split("\n").filter(Boolean);
  const choices = [...existing.map((p) => `Use existing project: ${p}`), "Create a new project"];
  const idx = existing.length > 0 ? await promptChoice("Which GCP project?", choices) : choices.length - 1;
  let project: string;
  if (idx < existing.length) {
    project = existing[idx]!;
  } else {
    project = await prompt("New project ID (lowercase, 6-30 chars, globally unique)", `whoop-mcp-${genToken().slice(0, 6)}`);
    console.log(c.gray(`    $ gcloud projects create ${project}`));
    if (await run("gcloud", ["projects", "create", project]) !== 0) { console.log(c.red("  Project creation failed.")); return false; }
  }
  return (await run("gcloud", ["config", "set", "project", project])) === 0;
}

const gcloudPrereqs: Prereq[] = [
  {
    label: "gcloud SDK installed",
    check: () => commandExists("gcloud"),
    ensure: async () => {
      if (commandExists("brew") && await promptYesNo("Install the gcloud SDK via Homebrew (brew install --cask google-cloud-sdk)?", true)) {
        await run("brew", ["install", "--cask", "google-cloud-sdk"]);
      }
      if (!commandExists("gcloud")) {
        console.log(c.gray("  Or install with the official script (follow its prompts):"));
        console.log(c.gray("    $ curl https://sdk.cloud.google.com | bash"));
        if (await promptYesNo("Run the gcloud install script now?", true)) {
          await run("sh", ["-c", "curl https://sdk.cloud.google.com | bash"]);
        }
      }
      if (!commandExists("gcloud")) {
        console.log(c.yellow("  gcloud still isn't on PATH — open a new terminal and re-run `whoop-mcp cloud`."));
        return false;
      }
      return true;
    },
  },
  {
    label: "authenticated with Google",
    check: () => capture("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]).stdout.trim().length > 0,
    ensure: async () => (await run("gcloud", ["auth", "login"])) === 0,
  },
  {
    label: "GCP project selected",
    check: () => { const p = capture("gcloud", ["config", "get-value", "project"]).stdout.trim(); return p.length > 0 && p !== "(unset)"; },
    ensure: () => selectOrCreateGcpProject(),
  },
  {
    label: "billing enabled (Cloud Run requires it)",
    check: () => {
      const p = capture("gcloud", ["config", "get-value", "project"]).stdout.trim();
      const b = capture("gcloud", ["billing", "projects", "describe", p, "--format=value(billingEnabled)"]);
      return b.code === 0 && /true/i.test(b.stdout);
    },
    ensure: async () => {
      const p = capture("gcloud", ["config", "get-value", "project"]).stdout.trim();
      console.log(c.yellow("  Cloud Run needs billing (the free tier still requires a card on file)."));
      console.log(c.gray(`  Enable it: https://console.cloud.google.com/billing/linkedaccount?project=${p}`));
      console.log(c.gray(`  Or: gcloud billing accounts list  →  gcloud billing projects link ${p} --billing-account=ACCT`));
      await promptYesNo("Press Enter once billing is enabled", true);
      return true;
    },
  },
];

// ── LOCAL flow ───────────────────────────────────────────────────────────────
export async function runLocalSetup(root: string): Promise<number> {
  console.log(c.bold("\nwhoop-mcp · local setup") + c.gray(" — run the MCP on this machine over stdio\n"));
  const TOTAL = 3;
  const serverJs = resolve(root, "dist", "server.js");

  step(1, TOTAL, "Prerequisites");
  if (!(await preflight([nodePrereq, depsPrereq(root), buildPrereq(root)]))) return 1;

  step(2, TOTAL, "Whoop authentication");
  if (!(await ensureAuth(root))) return 1;
  console.log(c.green("  ✓ tokens in .env"));

  step(3, TOTAL, "Wire into your AI client");
  const client = await promptChoice("Which client?", [
    "Claude Desktop (write config automatically)",
    "Claude Code (print the one-line command)",
    "Just show me the config — I'll paste it",
  ]);

  let wired = false;
  if (client === 1) {
    console.log("");
    const manual = `claude mcp add whoop ${process.execPath} ${serverJs}`;
    if (commandExists("claude")) {
      if (await promptYesNo("Run `claude mcp add whoop …` for you now?", true)) {
        if (await run("claude", ["mcp", "add", "whoop", process.execPath, serverJs]) === 0) {
          console.log(c.green("  ✓ added to Claude Code"));
          wired = true;
        } else {
          console.log(c.yellow("  That didn't work — run it yourself:"));
          console.log(`  ${manual}`);
        }
      } else {
        console.log(c.gray("  Run it when ready:"));
        console.log(`  ${manual}`);
      }
    } else {
      console.log(c.gray("  The `claude` CLI isn't on PATH. Install Claude Code, then run:"));
      console.log(`  ${manual}`);
    }
  } else if (client === 0) {
    const home = process.env.HOME ?? "~";
    const cfgPath = resolve(home, "Library/Application Support/Claude/claude_desktop_config.json");
    const entry = { command: process.execPath, args: [serverJs] };
    let merged: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(cfgPath)) {
      try { merged = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { merged = {}; }
    }
    merged.mcpServers = { ...(merged.mcpServers ?? {}), whoop: entry };
    if (await promptYesNo(`Write the 'whoop' server into ${cfgPath}?`, true)) {
      writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
      console.log(c.green("  ✓ Claude Desktop config updated"));
      console.log(c.yellow("  → Quit and reopen Claude Desktop to load it."));
      wired = true;
    }
  } else {
    const home = process.env.HOME ?? "~";
    const cfgPath = resolve(home, "Library/Application Support/Claude/claude_desktop_config.json");
    console.log("");
    console.log(c.bold("  To finish, add this to Claude Desktop:"));
    console.log(c.gray("  1. Open (create if missing):"));
    console.log(`     ${cfgPath}`);
    console.log(c.gray('  2. Merge the "whoop" block into your existing "mcpServers" — don\'t overwrite the file:'));
    console.log("");
    console.log(JSON.stringify({ mcpServers: { whoop: { command: process.execPath, args: [serverJs] } } }, null, 2));
    console.log("");
    console.log(c.gray("  3. Quit and reopen Claude Desktop."));
    console.log(c.gray("  Using Claude Code instead? Run: ") + c.bold(`claude mcp add whoop ${process.execPath} ${serverJs}`));
  }

  if (wired) {
    console.log(c.green("\n✓ Local setup complete.") + c.gray(" Quit/reopen the client, then ask: \"how am I doing today on whoop?\"\n"));
  } else {
    console.log(c.yellow("\n→ Almost done.") + c.gray(" Finish the step above (paste the config or run the command) + restart your client, then ask: \"how am I doing today on whoop?\"\n"));
  }
  closePrompts();
  return 0;
}

// ── CLOUD flow ─────────────────────────────────────────────────────────────
interface DeployCtx {
  root: string;
  env: Record<string, string>; // everything except PUBLIC_URL
  appName: string;
  password: string;
}

export async function runCloudSetup(root: string): Promise<number> {
  console.log(c.bold("\nwhoop-mcp · cloud setup") + c.gray(" — deploy a server + connect it to Claude (web, desktop, mobile)\n"));
  const TOTAL = 6;
  if (!(await preflight([nodePrereq, depsPrereq(root)]))) return 1;

  step(1, TOTAL, "Whoop authentication");
  if (!(await ensureAuth(root))) return 1;
  const env = readEnv(root);
  console.log(c.green("  ✓ tokens ready"));

  step(2, TOTAL, "Choose a host");
  const platformIdx = await promptChoice("Where should the server run?", [
    `Fly.io          ${c.gray("— fully automated + tested. ~$2/mo (no free tier).")}`,
    `Railway         ${c.gray("— $5/mo credit, always-on. CLI-driven.")}`,
    `Google Cloud Run ${c.gray("— generous free tier, scales to zero. Needs gcloud SDK.")}`,
    `Custom / own server ${c.gray("— step-by-step Docker instructions, no automation.")}`,
  ]);
  const platforms = ["fly", "railway", "cloudrun", "custom"] as const;
  const platform = platforms[platformIdx]!;

  // Per-host prerequisites (install the CLI, log in, and for gcloud pick/create a
  // project + billing) — guided, auto-skipping whatever you already have, BEFORE
  // we generate secrets or deploy. Returns to the main flow when satisfied.
  const hostPrereqs = platform === "fly" ? flyPrereqs
    : platform === "railway" ? railwayPrereqs
    : platform === "cloudrun" ? gcloudPrereqs
    : [];
  if (hostPrereqs.length && !(await preflight(hostPrereqs))) return 1;

  step(3, TOTAL, "Generate secrets");
  const mcpToken = genToken();
  console.log(`  MCP_AUTH_TOKEN: ${c.gray(mcpToken.slice(0, 12) + "… (generated)")}`);
  console.log(c.gray("  Connector password — you'll paste this into Claude once when adding the server."));
  console.log(c.gray("  Press Enter to auto-generate a secure 18-char one, or type your own (min 12)."));
  const useGenerated = (pw: string): string => {
    const copied = copyToClipboard(pw);
    console.log(`  ${c.green("✓")} generated: ${c.bold(pw)}${copied ? c.green("   ✓ copied to clipboard") : c.gray("   (copy it now)")}`);
    return pw;
  };
  let password = await prompt("Password (Enter = auto-generate)");
  if (password === "") {
    password = useGenerated(genPassword(18));
  } else {
    while (password.length < 12) {
      console.log(c.red("  Use at least 12 characters (or press Enter to auto-generate)."));
      password = await prompt("Password (Enter = auto-generate)");
      if (password === "") { password = useGenerated(genPassword(18)); break; }
    }
  }

  const baseEnv: Record<string, string> = {
    WHOOP_EMAIL: env.WHOOP_EMAIL ?? "",
    WHOOP_IOS_BEARER_TOKEN: env.WHOOP_IOS_BEARER_TOKEN ?? "",
    WHOOP_COGNITO_REFRESH_TOKEN: env.WHOOP_COGNITO_REFRESH_TOKEN ?? "",
    MCP_TRANSPORT: "http",
    MCP_AUTH_TOKEN: mcpToken,
    AUTH_PASSWORD: password,
    WHOOP_TOKEN_STORE: "memory",
  };
  if (env.WHOOP_USER_ID) baseEnv.WHOOP_USER_ID = env.WHOOP_USER_ID;

  step(4, TOTAL, `Deploy to ${platform}`);
  const defaultName = `whoop-mcp-${genToken().slice(0, 6)}`;
  let appName = "whoop-mcp";
  if (platform !== "custom") {
    console.log(c.gray("  App name is optional — press Enter to use the suggested one in [brackets],"));
    console.log(c.gray("  or type your own (must be globally unique on the host)."));
    appName = await prompt("App name (Enter = use suggested)", defaultName);
  }
  const ctx: DeployCtx = { root, env: baseEnv, appName, password };

  let url: string | null = null;
  if (platform === "fly") url = await deployFly(ctx);
  else if (platform === "railway") url = await deployRailway(ctx);
  else if (platform === "cloudrun") url = await deployCloudRun(ctx);
  else url = await deployCustom(ctx);

  if (!url) {
    console.log(c.yellow("\nDeploy didn't complete automatically. Follow the steps above, then re-run `whoop-mcp cloud` or set PUBLIC_URL + redeploy manually."));
    closePrompts();
    return 1;
  }

  step(5, TOTAL, "Verify the server + OAuth are live");
  const ok = await verifyDeployment(url);
  if (!ok) {
    console.log(c.yellow("  Couldn't confirm the OAuth endpoints yet (the host may still be starting). Give it a minute, then run `whoop-mcp ping`."));
  }
  writeDeployRecord(root, { platform, app: appName, url });

  step(6, TOTAL, "Connect to Claude");
  printConnectInstructions(url, password);
  closePrompts();
  return 0;
}

// ── verification ─────────────────────────────────────────────────────────────
async function verifyDeployment(baseUrl: string): Promise<boolean> {
  const root = baseUrl.replace(/\/(mcp)?$/, "");
  // Poll fast: a short per-attempt timeout means a not-yet-propagated DNS / cold
  // start fails in ~3s instead of hanging the full 12s default, and a tight 1.5s
  // interval detects readiness within ~1.5s of the host coming up. (Previously a
  // 12s timeout × 3s sleep × 10 made this feel like ~3 minutes.)
  const deadline = Date.now() + 90_000;
  let healthy = false;
  let announced = false;
  while (Date.now() < deadline) {
    const health = await httpGet(`${root}/health`, 3000);
    if (health.status === 200) { healthy = true; break; }
    if (!announced) { console.log(c.gray(`  waiting for ${root} (DNS + first boot)…`)); announced = true; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  /health: ${healthy ? c.green("200 ✓") : c.red("timeout")}`);
  const prm = await httpGet(`${root}/.well-known/oauth-protected-resource/mcp`, 5000);
  const prmOk = prm.status === 200 && prm.body.includes("/mcp");
  console.log(`  OAuth metadata: ${prmOk ? c.green("✓") : c.red("not found")}`);
  return healthy && prmOk;
}

function printConnectInstructions(url: string, password: string): void {
  const mcpUrl = url.replace(/\/$/, "") + "/mcp";
  console.log("");
  console.log(c.bold("  Add it to Claude (syncs across web, desktop, and mobile):"));
  console.log(`  1. Open ${c.cyan("claude.ai")} → Settings → Connectors → ${c.bold("Add custom connector")}`);
  console.log(`  2. URL:      ${c.brand(mcpUrl)}`);
  console.log(`  3. Password: ${c.brand(password)}`);
  console.log(`  4. Approve. Done — every device on your account now has Whoop.`);
  console.log("");
  // Best-effort: open the connectors page in the browser (cross-platform).
  openUrl("https://claude.ai/settings/connectors");
  console.log(c.gray("  (tried to open the connectors page in your browser)"));
  console.log(c.green("\n✓ Cloud setup complete.\n"));
}

// ── platform adapters ────────────────────────────────────────────────────────

function setSummary(env: Record<string, string>): void {
  console.log(c.gray("  env to set: " + Object.keys(env).join(", ")));
}

// FLY — fully automated + tested.
async function deployFly(ctx: DeployCtx): Promise<string | null> {
  const fly = commandExists("fly") ? "fly" : "flyctl";
  const url = `https://${ctx.appName}.fly.dev`;
  const env = { ...ctx.env, PUBLIC_URL: url };

  // Create the app (idempotent-ish: ignore "already exists").
  const create = capture(fly, ["apps", "create", ctx.appName, "--json"]);
  if (create.code !== 0 && !/already|taken/i.test(create.stderr + create.stdout)) {
    console.log(c.red(`  Couldn't create app '${ctx.appName}': ${create.stderr.trim() || create.stdout.trim()}`));
    return null;
  }
  // Minimal fly.toml so `fly deploy` is non-interactive (builds the Dockerfile).
  writeFileSync(resolve(ctx.root, "fly.toml"), [
    `app = "${ctx.appName}"`,
    `primary_region = "sjc"`,
    ``,
    `[build]`,
    ``,
    `[http_service]`,
    `  internal_port = 3000`,
    `  force_https = true`,
    `  auto_stop_machines = "stop"`,
    `  auto_start_machines = true`,
    `  min_machines_running = 0`,
    ``,
  ].join("\n"));
  // Set secrets (staged; applied on deploy).
  const secretArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  console.log(c.gray("  setting secrets…"));
  if (await run(fly, ["secrets", "set", ...secretArgs, "--app", ctx.appName, "--stage"]) !== 0) {
    console.log(c.yellow("  (secrets --stage failed; retrying without --stage)"));
    await run(fly, ["secrets", "set", ...secretArgs, "--app", ctx.appName]);
  }
  console.log(c.gray("  deploying (builds the Dockerfile, ~1-2 min)…"));
  if (await run(fly, ["deploy", "--app", ctx.appName, "--ha=false"], { cwd: ctx.root }) !== 0) return null;
  return url;
}

// Shared "assisted" deploy for platforms I can't live-test: run the documented
// commands, then ask the user to paste the resulting URL (robust vs. parsing).
async function assistedDeploy(opts: {
  cliName: string;
  install: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string };
  loginCheck: () => boolean;
  loginCmd: () => Promise<number>;
  steps: Array<{ desc: string; cmd: [string, string[]] }>;
  setPublicUrlCmds: (url: string) => Array<[string, string[]]>;
  ctx: DeployCtx;
}): Promise<string | null> {
  if (!commandExists(opts.cliName)) {
    if (!(await ensureCli(opts.cliName, opts.install))) return null;
  }
  if (!opts.loginCheck()) {
    console.log(c.gray(`  Logging into ${opts.cliName}…`));
    if (await opts.loginCmd() !== 0) return null;
  }
  setSummary(opts.ctx.env);
  for (const s of opts.steps) {
    console.log(c.gray(`  → ${s.desc}`));
    console.log(c.gray(`    $ ${s.cmd[0]} ${s.cmd[1].join(" ")}`));
    if (await run(s.cmd[0], s.cmd[1], { cwd: opts.ctx.root }) !== 0) {
      console.log(c.yellow(`  That step failed. You can run it manually and continue.`));
      if (!(await promptYesNo("Continue anyway?", false))) return null;
    }
  }
  let url = (await prompt("Paste your deployment's public URL (e.g. https://your-app.up.railway.app)")).trim();
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url; // accept a bare domain
  if (!/^https?:\/\/[^/.]+\.[^/]+/.test(url)) { console.log(c.red("  Need a valid URL (e.g. https://your-app.up.railway.app).")); return null; }
  url = url.replace(/\/$/, "");
  // OAuth's issuer must equal the real URL, which we only know now — so set
  // PUBLIC_URL and redeploy automatically (run() inherits stdio → the user sees
  // progress) rather than asking them to run a command in a second terminal.
  console.log(c.gray("  Setting PUBLIC_URL + redeploying so OAuth works…"));
  for (const [cmd, args] of opts.setPublicUrlCmds(url)) {
    console.log(c.gray(`    $ ${cmd} ${args.join(" ")}`));
    if (await run(cmd, args, { cwd: opts.ctx.root }) !== 0) {
      console.log(c.yellow("  That command failed — run it yourself, then continue."));
      if (!(await promptYesNo("Continue anyway?", false))) return null;
    }
  }
  return url;
}

// RAILWAY — CLI-automatable; best-effort (untested).
async function deployRailway(ctx: DeployCtx): Promise<string | null> {
  // Railway rejects `--set KEY=` (empty value), and PUBLIC_URL isn't known until
  // `domain` runs — so set the non-empty vars now, PUBLIC_URL in the 2nd pass.
  const varArgs: string[] = ["variables"];
  for (const [k, v] of Object.entries(ctx.env)) {
    if (v === "") continue;
    varArgs.push("--set", `${k}=${v}`);
  }
  return assistedDeploy({
    cliName: "railway",
    install: { npmPkg: "@railway/cli", brewPkg: "railway", manualHint: "npm i -g @railway/cli  (or: brew install railway)" },
    loginCheck: () => capture("railway", ["whoami"]).code === 0,
    loginCmd: () => run("railway", ["login"]),
    steps: [
      // `railway init` creates a PROJECT, not a service; `railway variables` needs
      // a service. `railway up` is what creates the service, so it must run first
      // (it deploys env-less + crashes once, then the variables step redeploys it
      // healthy — Railway auto-redeploys when variables change).
      { desc: "create the project", cmd: ["railway", ["init", "--name", ctx.appName]] },
      { desc: "deploy (creates the service + builds the Dockerfile)", cmd: ["railway", ["up", "--detach"]] },
      { desc: "set environment variables (redeploys with them)", cmd: ["railway", varArgs] },
      { desc: "generate a public domain", cmd: ["railway", ["domain"]] },
    ],
    setPublicUrlCmds: (url) => [
      ["railway", ["variables", "--set", `PUBLIC_URL=${url}`]],
      ["railway", ["up", "--detach"]],
    ],
    ctx,
  });
}

// GOOGLE CLOUD RUN — gcloud, builds from source. Best-effort.
async function deployCloudRun(ctx: DeployCtx): Promise<string | null> {
  // Env vars go in a temp YAML file (--env-vars-file), NOT --set-env-vars: values
  // include an email (with `@`) and a random password, so any inline delimiter can
  // collide (the `^@^` form broke on the email's `@`). The file lives in the OS
  // temp dir — never the `--source` upload dir — and is deleted after. PUBLIC_URL
  // is set in the 2nd pass once the deployed URL is known.
  const envYaml = Object.entries(ctx.env)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n") + "\n";
  const envFile = resolve(tmpdir(), `whoop-mcp-env-${randomUUID()}.yaml`);
  writeFileSync(envFile, envYaml, { mode: 0o600 });
  try {
    return await assistedDeploy({
      cliName: "gcloud",
      install: { manualHint: "install the gcloud SDK: https://cloud.google.com/sdk/docs/install" },
      loginCheck: () => capture("gcloud", ["config", "get-value", "project"]).stdout.trim().length > 0,
      loginCmd: async () => {
        const a = await run("gcloud", ["auth", "login"]);
        if (a !== 0) return a;
        console.log(c.gray("  Set your project: gcloud config set project <PROJECT_ID>"));
        await promptYesNo("Project set?", true);
        return 0;
      },
      steps: [
        {
          desc: "enable required APIs (run, cloudbuild, artifactregistry)",
          cmd: ["gcloud", ["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com"]],
        },
        {
          // gcloud run deploy --source builds via the project's COMPUTE default
          // service account, which on new projects lacks build permissions
          // (PERMISSION_DENIED resolving the source). Grant the builder role.
          desc: "grant Cloud Build access to the default service account",
          cmd: ["sh", ["-c", 'P="$(gcloud config get-value project 2>/dev/null)"; N="$(gcloud projects describe "$P" --format=\'value(projectNumber)\' 2>/dev/null)"; gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:${N}-compute@developer.gserviceaccount.com" --role=roles/cloudbuild.builds.builder --condition=None']],
        },
        {
          desc: "deploy from source (Cloud Build builds the Dockerfile)",
          cmd: ["gcloud", [
            "run", "deploy", ctx.appName,
            "--source", ".",
            "--region", "us-west1",
            "--allow-unauthenticated",
            "--port", "3000",
            "--env-vars-file", envFile,
            "--quiet",
          ]],
        },
      ],
      setPublicUrlCmds: (url) => [
        ["gcloud", ["run", "services", "update", ctx.appName, "--region", "us-west1", "--update-env-vars", `PUBLIC_URL=${url}`, "--quiet"]],
      ],
      ctx,
    });
  } finally {
    try { rmSync(envFile); } catch { /* best-effort */ }
  }
}

// CUSTOM — printed guide for any other platform or your own server.
async function deployCustom(ctx: DeployCtx): Promise<string | null> {
  console.log("");
  console.log(c.bold("  Custom / self-hosted deploy"));
  console.log(c.gray("  1. Build the image (the repo ships a Dockerfile):"));
  console.log(`     docker build -t whoop-mcp .`);
  console.log(c.gray("  2. Run it with these env vars (HTTPS + a public hostname required):"));
  for (const [k, v] of Object.entries(ctx.env)) {
    const shown = ["MCP_AUTH_TOKEN", "AUTH_PASSWORD", "WHOOP_IOS_BEARER_TOKEN", "WHOOP_COGNITO_REFRESH_TOKEN"].includes(k)
      ? v.slice(0, 8) + "…"
      : v;
    console.log(`       ${c.brand(k)}=${shown}`);
  }
  console.log(c.gray("  3. Set PUBLIC_URL to your server's public origin (e.g. https://whoop.example.com)."));
  console.log(c.gray("  4. Make sure port 3000 is reachable over HTTPS."));
  console.log("");
  const url = await prompt("Once it's live, paste the public URL");
  if (!url.startsWith("http")) { console.log(c.red("  Need a valid https URL.")); return null; }
  return url.replace(/\/$/, "");
}
