// Background-service install/uninstall for the Goose Tools caption worker.
// Mirrors the carousel worker's installer, but installs alongside it — its own
// login service + its own background copy — so a computer can run both. The
// worker TOKEN is shared: both tools read ~/.goosetools/env, so if this
// computer is already connected (for carousels), `install` needs no --token.
//
// `install` makes the caption worker persistent; `update` re-runs it against
// the newest code; `status` reports what's actually running.

import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const GOOSE_DIR = join(homedir(), ".goosetools");
const ENV_FILE = join(GOOSE_DIR, "env"); // shared with the carousel worker
const APP_PREFIX = join(GOOSE_DIR, "caption-app"); // separate from the carousel copy
const INSTALLED_CLI = join(APP_PREFIX, "node_modules", "caption-maker-worker", "worker", "cli.js");

const MAC_LABEL = "com.goosetools.caption";
const MAC_PLIST = join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const WIN_TASK = "GooseTools Caption Worker";
const WIN_VBS = join(GOOSE_DIR, "run-caption-worker.vbs");
const LOG_FILE = join(GOOSE_DIR, "caption-worker.log");
const ERR_FILE = join(GOOSE_DIR, "caption-worker.err.log");

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], ...opts })
    .toString()
    .trim();
}

function quietSh(cmd) {
  try {
    sh(cmd);
    return true;
  } catch {
    return false;
  }
}

function npmGlobalBin() {
  try {
    const prefix = sh("npm prefix -g", { shell: true });
    return process.platform === "win32" ? prefix : join(prefix, "bin");
  } catch {
    return "";
  }
}

function servicePath() {
  const parts = [
    dirname(process.execPath),
    npmGlobalBin(),
    ...(process.platform === "win32"
      ? [process.env.PATH ?? ""]
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
  ].filter(Boolean);
  return [...new Set(parts)].join(process.platform === "win32" ? ";" : ":");
}

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

function writeEnvFile({ url, token }) {
  mkdirSync(GOOSE_DIR, { recursive: true });
  writeFileSync(ENV_FILE, `GOOSETOOLS_URL=${url}\nWORKER_TOKEN=${token}\n`);
  chmodSync(ENV_FILE, 0o600);
}

function installStableCopy(root) {
  console.log("Setting up the background copy (this can take a minute)…");
  mkdirSync(APP_PREFIX, { recursive: true });
  const source = existsSync(join(root, ".git")) ? `"${root}"` : "caption-maker-worker@latest";
  execSync(`npm install --no-fund --no-audit --loglevel=error --prefix "${APP_PREFIX}" ${source}`, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: true,
  });
  if (!existsSync(INSTALLED_CLI)) {
    throw new Error("background copy did not install where expected");
  }
}

// ── macOS (launchd) ──────────────────────────────────────────────────────────

function macPlist() {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MAC_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(process.execPath)}</string>
        <string>${esc(INSTALLED_CLI)}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${esc(LOG_FILE)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(ERR_FILE)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${esc(servicePath())}</string>
    </dict>
</dict>
</plist>
`;
}

function macInstall() {
  mkdirSync(dirname(MAC_PLIST), { recursive: true });
  writeFileSync(MAC_PLIST, macPlist());
  const uid = process.getuid();
  quietSh(`launchctl bootout gui/${uid}/${MAC_LABEL}`);
  if (!quietSh(`launchctl bootstrap gui/${uid} "${MAC_PLIST}"`)) {
    quietSh(`launchctl unload "${MAC_PLIST}"`);
    execSync(`launchctl load -w "${MAC_PLIST}"`, { stdio: "ignore" });
  }
}

function macUninstall() {
  quietSh(`launchctl bootout gui/${process.getuid()}/${MAC_LABEL}`);
  quietSh(`launchctl unload "${MAC_PLIST}"`);
  rmSync(MAC_PLIST, { force: true });
}

// ── Windows (Scheduled Task at logon, hidden window) ─────────────────────────

function winInstall() {
  const vbs = `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${INSTALLED_CLI}"" run", 0, False\r\n`;
  writeFileSync(WIN_VBS, vbs);
  quietSh(`schtasks /End /TN "${WIN_TASK}"`);
  quietSh(`schtasks /Delete /F /TN "${WIN_TASK}"`);
  execSync(`schtasks /Create /F /SC ONLOGON /TN "${WIN_TASK}" /TR "wscript.exe \\"${WIN_VBS}\\""`, {
    stdio: "ignore",
    shell: true,
  });
  execSync(`schtasks /Run /TN "${WIN_TASK}"`, { stdio: "ignore", shell: true });
}

function winUninstall() {
  quietSh(`schtasks /End /TN "${WIN_TASK}"`);
  quietSh(`schtasks /Delete /F /TN "${WIN_TASK}"`);
  rmSync(WIN_VBS, { force: true });
}

// ── Public commands ──────────────────────────────────────────────────────────

export function install({ url, token, root }) {
  // The token is shared with the carousel worker — reuse the saved one if the
  // caller didn't pass --token (a computer already connected for carousels).
  const saved = readEnvFile();
  const effectiveToken = token ?? saved.WORKER_TOKEN;
  const effectiveUrl = url ?? saved.GOOSETOOLS_URL ?? "https://goosetools.com";
  if (!effectiveToken) {
    console.error(
      "No worker token found. Connect this computer at " +
        effectiveUrl +
        "/dashboard/caption (or /dashboard/carousel — same token), then run:\n" +
        "  npx --yes caption-maker-worker@latest install --token gt_…",
    );
    process.exit(1);
  }
  writeEnvFile({ url: effectiveUrl, token: effectiveToken });
  installStableCopy(root);
  if (process.platform === "darwin") macInstall();
  else if (process.platform === "win32") winInstall();
  else {
    console.error(
      "Automatic background setup isn't available on this OS yet.\n" +
        "Run the worker directly instead:  caption-worker run",
    );
    process.exit(1);
  }
  console.log(
    "\n✓ All set! This computer now writes your captions in the background —\n" +
      "  whenever it's on, even after a restart. You can close this window.\n\n" +
      `  Logs:      ${LOG_FILE}\n` +
      "  Turn off:  npx --yes caption-maker-worker uninstall\n",
  );
}

export function uninstall() {
  if (process.platform === "darwin") macUninstall();
  else if (process.platform === "win32") winUninstall();
  // Only remove this worker's background copy + logs; leave the SHARED env
  // (and the carousel worker) untouched.
  rmSync(APP_PREFIX, { recursive: true, force: true });
  rmSync(LOG_FILE, { force: true });
  rmSync(ERR_FILE, { force: true });
  console.log("✓ Caption worker removed. (Your carousel worker and connection are untouched.)");
}

export function update({ root }) {
  const saved = readEnvFile();
  if (!saved.WORKER_TOKEN) {
    console.error(
      "No saved worker token — this computer hasn't been connected yet.\n" +
        "Connect at https://goosetools.com/dashboard/caption and run:\n" +
        "  npx --yes caption-maker-worker@latest install --token gt_…",
    );
    process.exit(1);
  }
  const before = installedVersion();
  installStableCopy(root);
  if (process.platform === "darwin") macInstall();
  else if (process.platform === "win32") winInstall();
  else {
    console.error("Automatic background setup isn't available on this OS yet.");
    process.exit(1);
  }
  const after = installedVersion();
  console.log(
    after && before && after !== before
      ? `\n✓ Updated ${before} → ${after} and restarted. Nothing else to do.\n`
      : `\n✓ Caption worker reinstalled (version ${after ?? "unknown"}) and restarted.\n`,
  );
}

// ── status ───────────────────────────────────────────────────────────────────
function installedVersion() {
  try {
    const pkg = join(APP_PREFIX, "node_modules", "caption-maker-worker", "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function latestVersion() {
  try {
    return sh("npm view caption-maker-worker version", { shell: true, timeout: 15000 });
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const parts = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

function servicePid() {
  try {
    if (process.platform === "darwin") {
      const line = sh(`launchctl list | grep ${MAC_LABEL}`, { shell: true });
      const pid = line.split(/\s+/)[0];
      return pid === "-" ? null : pid;
    }
    const out = sh(`schtasks /Query /TN "${WIN_TASK}" /FO LIST`, { shell: true });
    return /Running/i.test(out) ? "running" : null;
  } catch {
    return null;
  }
}

function tail(file, n) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

function lastWritten(file) {
  try {
    const ms = Date.now() - statSync(file).mtimeMs;
    const mins = Math.round(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.round(hours / 24)} days ago`;
  } catch {
    return "unknown";
  }
}

export function status() {
  const ok = (b) => (b ? "✓" : "✗");
  const env = readEnvFile();
  const installed = installedVersion();
  const latest = latestVersion();
  const pid = servicePid();
  const url = env.GOOSETOOLS_URL ?? "https://goosetools.com";

  console.log("\nGoose Tools caption worker — status\n");
  console.log(`  ${ok(installed)} Installed        ${installed ?? "not installed"}`);
  const cmp = installed && latest ? compareVersions(installed, latest) : 0;
  const stale = cmp < 0;
  if (latest) {
    const note = stale ? "  ← update available" : cmp > 0 ? "  (you're ahead — local dev build)" : "";
    console.log(`  ${ok(!stale)} Latest on npm    ${latest}${note}`);
  } else {
    console.log("  · Latest on npm    couldn't check (offline?)");
  }
  console.log(`  ${ok(pid)} Running          ${pid ? `yes (pid ${pid})` : "no"}`);
  console.log(`  ${ok(env.WORKER_TOKEN)} Token saved      ${env.WORKER_TOKEN ? "yes (shared)" : "no — connect a computer first"}`);
  console.log(`  · Server           ${url}`);
  console.log(`  · Logs             ${LOG_FILE}`);

  const errors = tail(ERR_FILE, 15);
  if (errors) {
    console.log(`\nErrors (last written ${lastWritten(ERR_FILE)}):\n${errors.replace(/^/gm, "  ")}`);
  }
  const log = tail(LOG_FILE, 15);
  if (log) {
    console.log(`\nActivity (last written ${lastWritten(LOG_FILE)}):\n${log.replace(/^/gm, "  ")}`);
  }

  if (stale) {
    console.log("\nTo update:  npx --yes caption-maker-worker@latest update\n");
  } else if (!pid && installed) {
    console.log("\nNot running. Restart it with:  npx --yes caption-maker-worker@latest update\n");
  } else {
    console.log("");
  }
}
