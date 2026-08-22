// Agent CLI adapter — runs a job's prompt through whichever coding-agent CLI
// the user picked on goosetools.com (claim payloads carry `agentCli`).
//
// VENDORED FILE: keep byte-identical across brand-manager-worker,
// caption-maker, and carousel-maker (worker/agent-cli.js in each). Fix a bug
// here, copy it to the other two.
//
// Modes, chosen for speed-vs-capability (see brand-manager commit c0c1b33 —
// tool-looping turned 36-second drafts into 10-minute ones):
//   "text"    — plain prompt-in/text-out, no tool flags at all (captions).
//   "oneshot" — tools explicitly OFF, all context inlined by the caller.
//   "read"    — file-reading allowed (carousel drafts look at photos).
//   "session" — tools ON and resumable where the CLI supports it.
//
// Honest capability notes per CLI:
//   claude   — full support: fine tool control, JSON envelope, --resume.
//   codex    — sandbox-level tool control only; resumable threads; JSONL out.
//   gemini   — no headless resume: sessionId is always null, callers replay
//              history (they already do this whenever sessionId is absent).
//   opencode — plain text out; session continuation is version-dependent, so
//              we don't claim it: sessionId is always null.
//
// Session ids are namespaced ("claude:<uuid>", "codex:<thread-id>") because
// the server stores them per conversation and the user can switch agents
// between turns — a Claude uuid means nothing to Codex. resolveSession()
// drops a mismatched id so the caller falls back to history replay. Bare
// un-prefixed ids predate namespacing and are treated as Claude's.

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";

export const AGENT_IDS = ["claude-code", "codex", "gemini", "opencode"];

const INSTALL_HINTS = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex, then run: codex login",
  gemini: "npm install -g @google/gemini-cli, then run: gemini (to sign in)",
  opencode: "npm install -g opencode-ai, then run: opencode auth login",
};

const LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

// Session-id namespace per agent. claude-code writes "claude:" for continuity
// with the bare ids already stored server-side.
const SESSION_PREFIX = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

function bin(agent) {
  if (agent === "claude-code") return process.env.CLAUDE_BIN ?? "claude";
  return agent; // codex / gemini / opencode binaries share their id
}

/** "claude" (legacy claim payloads) → "claude-code"; unknown → null. */
export function normalizeAgent(v) {
  if (v == null || v === "" ) return "claude-code";
  if (v === "claude") return "claude-code";
  return AGENT_IDS.includes(v) ? v : null;
}

/**
 * Turn a stored (possibly namespaced, possibly another agent's) session id
 * into one usable by `agent`, or null — null tells the caller to inline the
 * conversation history instead of resuming.
 */
export function resolveSession(agent, sessionId) {
  if (!sessionId) return null;
  const idx = sessionId.indexOf(":");
  if (idx === -1) {
    // Legacy bare id — those were always Claude Code session uuids.
    return agent === "claude-code" ? sessionId : null;
  }
  const prefix = sessionId.slice(0, idx);
  return prefix === SESSION_PREFIX[agent] ? sessionId.slice(idx + 1) : null;
}

function namespaced(agent, rawId) {
  return rawId ? `${SESSION_PREFIX[agent]}:${rawId}` : null;
}

// Strip ANSI escapes and other terminal noise some CLIs print around answers.
export function cleanText(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\[[0-9;]*[A-Za-z]/g, "").trim();
}

// stdio[0] MUST be "ignore". Inherited stdin makes invocations hang forever
// under launchd — brand-manager hit this exact bug (fixed in 3b1f955) and it
// presents as the worker silently doing nothing after a reboot.
function run(agent, args, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(agent), args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${LABELS[agent]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        err.code === "ENOENT"
          ? new Error(
              `${LABELS[agent]} isn't installed on this computer. Install: ${INSTALL_HINTS[agent]} — or switch your agent back to Claude Code in Setup on goosetools.com.`,
            )
          : err,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`${LABELS[agent]} exited ${code}: ${stderr.slice(0, 600)}`),
        );
    });
  });
}

/** Is the CLI on PATH? { installed, hint } — cheap, for startup diagnostics. */
export function detect(agent) {
  const res = spawnSync(bin(agent), ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  return {
    installed: res.status === 0,
    hint: INSTALL_HINTS[agent],
    label: LABELS[agent],
  };
}

// Tools Claude must NOT touch in oneshot mode — everything is inlined.
const CLAUDE_TOOLS_OFF = "Read,Edit,Write,Bash,Glob,Grep,WebFetch,WebSearch";

/**
 * Run a prompt through the chosen agent CLI.
 * Returns { text, sessionId } — sessionId is namespaced and null whenever
 * the CLI can't resume (callers then replay history on the next turn).
 */
export async function runAgent({
  agent = "claude-code",
  prompt,
  cwd,
  mode = "text",
  sessionId = null,
  tools = "Read,Edit,Write,Glob,Grep",
  timeoutMs = 5 * 60 * 1000,
}) {
  const normalized = normalizeAgent(agent);
  if (!normalized) {
    throw new Error(
      `Unknown agent "${agent}" — update this worker: npx --yes <package>@latest install`,
    );
  }
  const resume = resolveSession(normalized, sessionId);

  if (normalized === "claude-code") {
    if (mode === "session") {
      const args = [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        tools,
      ];
      if (resume) args.push("--resume", resume);
      const raw = await run(normalized, args, { timeoutMs, cwd });
      // The json envelope carries the session id. Be forgiving: a shape
      // change shouldn't lose the user's answer.
      try {
        const parsed = JSON.parse(raw);
        return {
          text: parsed.result ?? parsed.text ?? raw,
          sessionId: namespaced(
            normalized,
            parsed.session_id ?? parsed.sessionId ?? resume ?? null,
          ),
        };
      } catch {
        return { text: raw, sessionId: namespaced(normalized, resume) };
      }
    }
    const args = ["-p", prompt, "--output-format", "text"];
    if (mode === "oneshot") args.push("--disallowedTools", CLAUDE_TOOLS_OFF);
    if (mode === "read") args.push("--allowedTools", "Read");
    const text = await run(normalized, args, { timeoutMs, cwd });
    return { text, sessionId: null };
  }

  if (normalized === "codex") {
    // Sandbox is the only tool control codex offers; read-only + the prompt's
    // own "don't use tools" language is the closest match to oneshot.
    const sandbox = mode === "session" ? "workspace-write" : "read-only";
    const args = ["exec"];
    if (resume) args.push("resume", resume);
    args.push("--skip-git-repo-check", "--sandbox", sandbox, "--json");
    if (cwd) args.push("--cd", cwd);
    args.push(prompt);
    const raw = await run(normalized, args, { timeoutMs, cwd });
    // --json emits JSONL events; harvest the thread id and the last agent
    // message, falling back to the raw output if the shape ever changes.
    let threadId = resume ?? null;
    let last = null;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const evt = JSON.parse(trimmed);
        threadId =
          evt.thread_id ?? evt.session_id ?? evt.thread?.id ?? threadId;
        const item = evt.item ?? evt;
        const type = item.item_type ?? item.type;
        if (
          (type === "agent_message" || type === "assistant_message") &&
          typeof (item.text ?? item.message) === "string"
        ) {
          last = item.text ?? item.message;
        }
      } catch {
        // not an event line — ignore
      }
    }
    return {
      text: cleanText(last ?? raw),
      sessionId: mode === "session" ? namespaced(normalized, threadId) : null,
    };
  }

  if (normalized === "gemini") {
    // No reliable headless resume — never claim one. Session mode gets yolo
    // approvals so its tools can run unattended.
    const args = ["-p", prompt, "--output-format", "json"];
    if (mode === "session") args.push("--yolo");
    let raw;
    try {
      raw = await run(normalized, args, { timeoutMs, cwd });
    } catch (err) {
      // Older gemini builds lack --output-format; retry plain.
      if (!/output-format|unknown option/i.test(String(err.message))) throw err;
      raw = await run(normalized, ["-p", prompt], { timeoutMs, cwd });
      return { text: cleanText(raw), sessionId: null };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        text: cleanText(parsed.response ?? parsed.result ?? raw),
        sessionId: null,
      };
    } catch {
      return { text: cleanText(raw), sessionId: null };
    }
  }

  // opencode — plain text out; we don't claim session continuation (it's
  // version-dependent), so every turn replays history.
  const raw = await run(normalized, ["run", prompt], { timeoutMs, cwd });
  return { text: cleanText(raw), sessionId: null };
}
