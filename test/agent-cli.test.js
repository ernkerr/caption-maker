// Pin the adapter behaviors the caption worker leans on: agent normalization
// and the session-id rules (captions never resume, but the vendored file is
// shared — keep it honest here too).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAgent,
  resolveSession,
  cleanText,
} from "../worker/agent-cli.js";

test("normalizeAgent: legacy and default spellings", () => {
  assert.equal(normalizeAgent(undefined), "claude-code");
  assert.equal(normalizeAgent("claude"), "claude-code");
  assert.equal(normalizeAgent("codex"), "codex");
  assert.equal(normalizeAgent("nope"), null);
});

test("resolveSession keeps agents out of each other's sessions", () => {
  assert.equal(resolveSession("claude-code", "bare-id"), "bare-id");
  assert.equal(resolveSession("codex", "bare-id"), null);
  assert.equal(resolveSession("codex", "codex:t1"), "t1");
  assert.equal(resolveSession("gemini", "codex:t1"), null);
});

test("cleanText strips ANSI noise", () => {
  assert.equal(cleanText("\u001b[32mok\u001b[0m"), "ok");
});
