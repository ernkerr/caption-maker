// Goose Tools caption worker — polls the cloud queue, writes captions in the
// user's voice with the local Claude Code login, reports the text back. Runs
// on the user's own machine; talks to the server only over HTTPS with its
// worker token (the SAME token as the carousel worker — one connected computer
// serves both tools).

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Config: flags > env > worker/.env > ~/.goosetools/env ───────────────────
// The last one is written by the goosetools carousel setup; the caption worker
// reads the same file so a computer that's already connected needs no new token.
function parseEnvFile(p) {
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}
const dotenv = {
  ...parseEnvFile(join(homedir(), ".goosetools", "env")),
  ...parseEnvFile(join(ROOT, "worker", ".env")),
};
function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const BASE_URL = (
  flag("--url") ??
  process.env.GOOSETOOLS_URL ??
  dotenv.GOOSETOOLS_URL ??
  "https://goosetools.com"
).replace(/\/$/, "");
const TOKEN = flag("--token") ?? process.env.WORKER_TOKEN ?? dotenv.WORKER_TOKEN;
const POLL_MS = 30_000;

if (!TOKEN) {
  console.error(
    "Missing worker token. Connect your computer at " +
      BASE_URL +
      "/dashboard/caption (or /dashboard/carousel — same token), then run with --token gt_...",
  );
  process.exit(1);
}

// ── Server API ───────────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(`${BASE_URL}/api/caption/worker/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 401) {
    console.error("Worker token rejected — reconnect this computer at " + BASE_URL + "/dashboard/caption");
    process.exit(1);
  }
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Claude ─────────────────────────────────────────────────────────────────
// Draft with the local Claude Code login. Text in, text out — no tools needed
// (captions are pure text, unlike carousels which read photos).
async function claude(prompt) {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "text"],
    { maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000 },
  );
  return stdout;
}

// Strip the things models sometimes wrap a caption in despite being told not
// to: code fences, a leading "Here's..." line, surrounding quotes.
function cleanCaption(raw) {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  if (
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

const DEFAULT_VOICE =
  "Write in a natural, warm, concise voice. Sound like a real person, not a brand.";

function readRepoVoice() {
  try {
    return readFileSync(join(ROOT, "voice.md"), "utf8").trim();
  } catch {
    return DEFAULT_VOICE;
  }
}

// ── Caption job ──────────────────────────────────────────────────────────────
function captionPrompt(job) {
  const voice = job.voiceMd?.trim() || readRepoVoice() || DEFAULT_VOICE;
  const history = Array.isArray(job.history) ? job.history : [];

  let convo = "";
  if (history.length > 0) {
    convo = "\n## The conversation so far (oldest first)\n";
    history.forEach((turn, i) => {
      if (turn.instruction) convo += `\nYou were asked: "${turn.instruction}"`;
      if (turn.caption) convo += `\nDraft ${i + 1}:\n${turn.caption}\n`;
    });
  }

  const refine = job.instruction
    ? `\n## Now revise\nApply this note, keeping everything that already works: "${job.instruction}"\n`
    : "";

  return `You are writing ONE social media caption in a specific person's voice.

## The voice — follow it closely
${voice}

## What the post is about
${job.postContext ?? "(no context given — write a short, friendly caption)"}
${convo}${refine}
## Rules
- Return ONLY the caption text itself. No preamble, no "Here's a caption", no explanation, no surrounding quotes, no markdown code fences.
- Follow the voice's own rules on emoji, hashtags, length, and capitalization. If the voice says nothing about hashtags, don't add any.
- Write exactly one caption.`;
}

async function runCaptionJob(job) {
  const caption = cleanCaption(await claude(captionPrompt(job)));
  if (!caption) throw new Error("Claude returned an empty caption");
  await api("complete", { jobId: job.id, ok: true, caption });
  console.log(`✓ caption ${job.id}: ${caption.slice(0, 60).replace(/\n/g, " ")}…`);
}

// ── Voice job ────────────────────────────────────────────────────────────────
function voicePrompt(job) {
  const description = job.newVoice?.description ?? "";
  return `Turn this description of how someone writes into a reusable VOICE GUIDE
(markdown) that another writer could follow to sound exactly like them when
writing social captions.

## Their description
${description}

## Output
Return ONLY the markdown guide — no preamble, no code fences. Use short, skimmable
sections with these headings (drop any that don't apply):

# Voice
## Tone
## Do
## Don't
## Emoji & hashtags
## Sign-off / CTA
## Example phrases

Keep it concrete and specific to THIS person — quote their own words where the
description gives them.`;
}

async function runVoiceJob(job) {
  const voiceMd = (await claude(voicePrompt(job)))
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
  if (!voiceMd) throw new Error("Claude returned an empty voice guide");
  await api("complete", { jobId: job.id, ok: true, voiceMd });
  console.log(`✓ voice ${job.id}: guide written (${voiceMd.length} chars)`);
}

// ── Main loop ────────────────────────────────────────────────────────────────
console.log(`Goose Tools caption worker connected to ${BASE_URL} — waiting for jobs (Ctrl+C to stop)`);
let firstPoll = true;

while (true) {
  try {
    const job = await api("claim");
    if (firstPoll) {
      console.log("✓ Checked in — the website should show this computer as Connected now.");
      firstPoll = false;
    }
    if (job) {
      try {
        if (job.kind === "voice") {
          await runVoiceJob(job);
        } else if (job.kind === "caption" || !job.kind) {
          await runCaptionJob(job);
        } else {
          throw new Error(
            "This computer's caption worker is outdated for this job — update with: npx --yes caption-maker-worker@latest install",
          );
        }
      } catch (e) {
        console.error(`✗ job ${job.id}: ${e.message}`);
        await api("complete", { jobId: job.id, ok: false, error: e.message }).catch(() => {});
      }
      continue; // check for the next job immediately
    }
  } catch (e) {
    console.error(`Poll failed (will retry): ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
