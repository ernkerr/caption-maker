#!/usr/bin/env node
// caption-maker-worker entrypoint. Unlike the carousel worker there's no
// rendering browser to install — captions are pure text — so the only
// prerequisite is Claude Code, which writes them.
//
//   install    save token + register a login service (worker runs forever)
//   update     pull the newest code into the background copy + restart
//   status     what's installed, whether it's running, recent log lines
//   uninstall  remove the service + saved token
//   run        run the worker loop in this window (default)

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const command = ["install", "update", "status", "uninstall", "run", "doctor"].includes(process.argv[2])
  ? process.argv[2]
  : "run";

if (command === "uninstall") {
  const { uninstall } = await import("./service.js");
  uninstall();
  process.exit(0);
}

if (command === "status") {
  const { status } = await import("./service.js");
  status();
  process.exit(0);
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function has(cmd) {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: "ignore",
      shell: true,
    });
    return true;
  } catch {
    return false;
  }
}

// Claude Code is the default agent, so it's required to set up; the other
// agents (picked in Setup on goosetools.com) are checked lazily per job and
// reported by `doctor`.
if (command === "doctor") {
  const { AGENT_IDS, detect } = await import("./agent-cli.js");
  for (const id of AGENT_IDS) {
    const d = detect(id);
    console.log(
      `${d.installed ? "✓" : "✗"} ${d.label}${d.installed ? "" : `  — install: ${d.hint}`}`,
    );
  }
  process.exit(0);
}

if (!has("claude")) {
  console.error(
    "\nClaude Code isn't installed yet (it writes your captions).\n" +
      "Install it with:  npm install -g @anthropic-ai/claude-code\n" +
      "Then run:         claude   (once, to sign in — type /exit to leave)\n" +
      "Then run this command again.\n",
  );
  process.exit(1);
}

if (command === "install") {
  const { install } = await import("./service.js");
  install({
    url: (flag("--url") ?? "https://goosetools.com").replace(/\/$/, ""),
    token: flag("--token"),
    root: ROOT,
  });
} else if (command === "update") {
  const { update } = await import("./service.js");
  update({ root: ROOT });
} else {
  await import("./index.js");
}
