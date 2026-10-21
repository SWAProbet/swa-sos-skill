#!/usr/bin/env node
// Fails when an added or changed line in a TypeScript file is longer than the
// limit. Older long lines are left alone until someone touches them.
import { execFileSync } from "node:child_process";

const LIMIT = Number(process.env.LINE_LIMIT ?? 79);
const PATHS = ["*.ts", "*.mts", "*.cts", "*.js", "*.mjs"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// CI builds dev after the merge, so the merge's first parent is the base.
// Locally the base is where this branch left the integration branch.
function resolveBase() {
  if (process.env.LINE_LIMIT_BASE) return process.env.LINE_LIMIT_BASE;
  if (process.env.CODEBUILD_BUILD_ID || process.env.CI) {
    return tryGit(["rev-parse", "--verify", "-q", "HEAD^1"]);
  }
  const target = process.env.LINE_LIMIT_TARGET ?? "origin/dev";
  return tryGit(["merge-base", "HEAD", target]);
}

const ref = resolveBase();
const base = ref && tryGit(["rev-parse", "--verify", "-q", ref]);
if (!base) {
  console.error(
    "line-limit: no base commit to compare against. Set LINE_LIMIT_BASE " +
      "or fetch origin/dev; refusing to report a pass.",
  );
  process.exit(2);
}

const diff = git(["diff", "-U0", "--no-color", base, "HEAD", "--", ...PATHS]);
const failures = [];
let file = null;
let line = 0;
let examined = 0;
for (const row of diff.split("\n")) {
  if (row.startsWith("+++ ")) {
    file = row === "+++ /dev/null" ? null : row.slice(6);
  } else if (row.startsWith("@@")) {
    line = Number(/\+(\d+)/.exec(row)[1]);
  } else if (file && row.startsWith("+")) {
    const text = row.slice(1);
    examined += 1;
    if (text.length > LIMIT) {
      failures.push(`${file}:${line}: ${text.length} characters`);
    }
    line += 1;
  }
}

const short = base.slice(0, 7);
console.log(
  `line-limit: ${examined} added or changed lines since ${short}, ` +
    `limit ${LIMIT}.`,
);
if (failures.length) {
  console.error(`line-limit: ${failures.length} over the limit:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
