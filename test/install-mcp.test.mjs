import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "scripts", "install-mcp.mjs");
const server = join(root, "out", "mcp", "server.js");
const temporary = mkdtempSync(join(tmpdir(), "local-review-installer-"));
const log = join(temporary, "calls.jsonl");

const fakeCli = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const args = process.argv.slice(2);
if (basename(process.argv[1]) === "claude" && args[1] === "add") {
  const envIndex = args.indexOf("--env");
  if (envIndex !== -1) {
    for (const value of args.slice(envIndex + 1)) {
      if (value.startsWith("-")) break;
      if (!/^[^=]+=/.test(value)) {
        console.error("Invalid environment variable format: " + value);
        process.exit(1);
      }
    }
  }
}
appendFileSync(process.env.LOCAL_REVIEW_INSTALLER_TEST_LOG, JSON.stringify({
  command: basename(process.argv[1]), args: process.argv.slice(2),
}) + "\\n");
process.exit(process.argv[2] === "mcp" && process.argv[3] === "remove" ? 1 : 0);
`;

for (const command of ["claude", "codex", "gemini"]) {
  const executable = join(temporary, command);
  writeFileSync(executable, fakeCli);
  chmodSync(executable, 0o755);
}

const result = spawnSync(process.execPath, [installer], {
  cwd: root,
  encoding: "utf8",
  input: "yes\ny\ny\n",
  env: {
    ...process.env,
    LOCAL_REVIEW_INSTALLER_TEST_LOG: log,
    PATH: `${temporary}${delimiter}${process.env.PATH ?? ""}`,
  },
});

assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /Claude Code installed at user scope/);
assert.match(result.stdout, /Codex installed at user scope/);
assert.match(result.stdout, /Gemini CLI installed at user scope/);

const calls = readFileSync(log, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const additions = Object.fromEntries(
  calls
    .filter(({ args }) => args[0] === "mcp" && args[1] === "add")
    .map((call) => [call.command, call.args]),
);

assert.deepEqual(additions.claude, [
  "mcp", "add", "--scope", "user", "local-review", "--env",
  "LOCAL_REVIEW_AUTHOR=claude", "--", "node", server,
]);
assert.deepEqual(additions.codex, [
  "mcp", "add", "local-review", "--env", "LOCAL_REVIEW_AUTHOR=codex",
  "--", "node", server,
]);
assert.deepEqual(additions.gemini, [
  "mcp", "add", "-s", "user", "-e", "LOCAL_REVIEW_AUTHOR=gemini",
  "local-review", "node", server,
]);

for (const command of ["claude", "gemini"]) {
  const removal = calls.find(
    (call) => call.command === command && call.args[1] === "remove",
  );
  assert.equal(removal.args.includes("user"), true);
}

console.log("  ok   interactive installer uses user-level harness configuration");
