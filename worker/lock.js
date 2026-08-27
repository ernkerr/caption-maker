// One worker of each kind per machine.
//
// Nothing stops you starting a second worker: the daemon runs in the
// background, and `run` in a terminal is the normal way to watch one work or
// to try a change from a checkout. Both then poll the same queue with the same
// token.
//
// The server is safe — claiming a job is a single compare-and-set, so two
// workers never get the same one. The damage is quieter than that. They SPLIT
// the queue, so jobs land on whichever copy happened to pick them up: half
// from the code you're editing, half from the installed release, with a
// different state directory behind each. And the polling doubles, which is
// what the idle interval exists to keep down in the first place.
//
// So: whoever gets here first holds the lock, and the second one stands down
// with an explanation instead of quietly competing.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_DIR = join(homedir(), ".goosetools", "locks");

/**
 * Take the lock for `name` ("worker", "caption", "brand", "overlay"), or print
 * who has it and exit. Returns nothing — it either succeeds or ends the
 * process.
 *
 * `stopHint` is the command that stops the OTHER copy, and it's the whole
 * point of the message: "already running" without it just moves the puzzle.
 */
export function acquireWorkerLock(name, { label, stopHint }) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = join(LOCK_DIR, `${name}.pid`);

  const holder = readHolder(file);
  if (holder && isAlive(holder.pid)) {
    console.log(
      `\n${label} is already running on this computer (pid ${holder.pid}${
        holder.since ? `, since ${holder.since}` : ""
      }).\n\n` +
        "Two of them would split the queue between them — some jobs done by\n" +
        "one copy, some by the other. Stopping here instead.\n\n" +
        `  Stop the other one:  ${stopHint}\n`,
    );
    process.exit(0);
  }

  // Either no lock, or one left behind by a worker that was killed. Both are
  // ours to take: an O_EXCL create loses to a worker that beat us here by
  // milliseconds, which is the one race worth caring about.
  if (holder) rmSync(file, { force: true });
  let fd;
  try {
    fd = openSync(file, "wx");
  } catch {
    console.log(`\n${label} started somewhere else a moment ago. Stopping here.\n`);
    process.exit(0);
  }
  writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  closeSync(fd);

  const release = () => rmSync(file, { force: true });
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

function readHolder(file) {
  if (!existsSync(file)) return null;
  try {
    const [pid, since] = readFileSync(file, "utf8").split("\n");
    const n = Number.parseInt(pid, 10);
    return Number.isFinite(n) ? { pid: n, since: since?.trim() || null } : null;
  } catch {
    return null;
  }
}

// A pid file outlives a SIGKILLed worker, and pids get reused — so "is that
// pid alive" isn't enough on its own. Checking that it's a node process is
// cheap and rules out the reuse case that would otherwise lock out the daemon
// until someone deleted the file by hand.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return /node/.test(execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return false;
  }
}
