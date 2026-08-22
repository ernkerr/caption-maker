// Goose Tools caption worker — polls the cloud queue, writes captions in the
// user's voice with the local agent CLI login (Claude Code by default; the
// claim payload's agentCli can pick codex/gemini/opencode), reports the text
// back. Runs
// on the user's own machine; talks to the server only over HTTPS with its
// worker token (the SAME token as the carousel worker — one connected computer
// serves both tools).

import { runAgent } from "./agent-cli.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── Agent ──────────────────────────────────────────────────────────────────
// Draft with the local agent CLI the user picked on goosetools.com (the claim
// payload's agentCli; Claude Code when absent). Text in, text out — no tools
// needed (captions are pure text, unlike carousels which read photos).
async function draft(job, prompt) {
  const { text } = await runAgent({
    agent: job.agentCli,
    prompt,
    mode: "text",
    timeoutMs: 5 * 60 * 1000,
  });
  return text;
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
  const caption = cleanCaption(await draft(job, captionPrompt(job)));
  if (!caption) throw new Error("The agent returned an empty caption");
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
  const voiceMd = (await draft(job, voicePrompt(job)))
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
  if (!voiceMd) throw new Error("The agent returned an empty voice guide");
  await api("complete", { jobId: job.id, ok: true, voiceMd });
  console.log(`✓ voice ${job.id}: guide written (${voiceMd.length} chars)`);
}

// ── Learn job ────────────────────────────────────────────────────────────────
// After a caption, fold what the user kept (and any correction they made) back
// into their voice guide — so it sharpens over time like a chat that remembers.
// Only rewrites when there's a durable preference to capture; otherwise leaves
// the guide untouched (reported by completing without a voiceMd).
function stripFences(text) {
  return text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
}

function learnPrompt(job) {
  const current = job.voiceMd?.trim() || readRepoVoice() || DEFAULT_VOICE;
  const l = job.learn ?? {};
  const bits = [`Post was about: ${job.postContext ?? "(not given)"}`];
  if (l.beforeCaption) bits.push(`Draft the user refined away:\n${l.beforeCaption}`);
  if (l.instruction) bits.push(`What the user asked to change: "${l.instruction}"`);
  if (l.afterCaption) bits.push(`Caption the user kept:\n${l.afterCaption}`);

  return `You maintain a living VOICE GUIDE for one person's social captions. It
should get sharper over time by absorbing how they actually want captions
written — especially the corrections they make.

## Current voice guide
${current}

## The latest interaction to learn from
${bits.join("\n\n")}

## Your task
Update the guide ONLY if this interaction reveals a DURABLE, GENERALIZABLE
preference — a rule about tone, length, emoji, hashtags, phrasing, structure, or
words to use or avoid. Fold it in naturally: merge with existing rules, never
duplicate, keep the whole guide tight and skimmable. Keep a "## Learned" section
at the end for preferences picked up this way; append or sharpen bullets there.

If the change was one-off, or the guide already covers it, change NOTHING and
return the guide EXACTLY as-is.

Return ONLY the full markdown guide — no preamble, no code fences, no commentary.`;
}

async function runLearnJob(job) {
  const current = (job.voiceMd ?? "").trim();
  const updated = stripFences(await draft(job, learnPrompt(job)));
  if (!updated || updated === current) {
    // Nothing durable to learn — leave the guide untouched (no voiceMd → the
    // server skips the write).
    await api("complete", { jobId: job.id, ok: true });
    console.log(`· learn ${job.id}: no change`);
    return;
  }
  await api("complete", { jobId: job.id, ok: true, voiceMd: updated });
  console.log(`✓ learn ${job.id}: voice updated (${updated.length} chars)`);
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
        } else if (job.kind === "learn") {
          await runLearnJob(job);
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
