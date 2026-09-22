#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "out", "mcp", "server.js");
const serverName = "local-review";

const harnesses = [
  {
    label: "Claude Code",
    command: "claude",
    removeArgs: ["mcp", "remove", "--scope", "user", serverName],
    addArgs: [
      "mcp",
      "add",
      "--scope",
      "user",
      "--env",
      "LOCAL_REVIEW_AUTHOR=claude",
      serverName,
      "--",
      "node",
      server,
    ],
  },
  {
    label: "Codex",
    command: "codex",
    removeArgs: ["mcp", "remove", serverName],
    addArgs: [
      "mcp",
      "add",
      serverName,
      "--env",
      "LOCAL_REVIEW_AUTHOR=codex",
      "--",
      "node",
      server,
    ],
  },
  {
    label: "Gemini CLI",
    command: "gemini",
    removeArgs: ["mcp", "remove", "-s", "user", serverName],
    addArgs: [
      "mcp",
      "add",
      "-s",
      "user",
      "-e",
      "LOCAL_REVIEW_AUTHOR=gemini",
      serverName,
      "node",
      server,
    ],
  },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function commandExists(command) {
  const result = run(command, ["--version"], { stdio: "ignore" });
  return !result.error || result.error.code !== "ENOENT";
}

async function confirm(lines, label) {
  while (true) {
    output.write(`Install for ${label}? [y/N] `);
    const { value, done } = await lines.next();
    if (done) return false;

    const answer = value.trim().toLowerCase();

    if (answer === "" || answer === "n" || answer === "no") return false;
    if (answer === "y" || answer === "yes") return true;

    console.log("Please answer yes or no.");
  }
}

function compileServer() {
  console.log("\nBuilding the MCP server...");
  const result = run("pnpm", ["run", "compile"], { stdio: "inherit" });

  if (result.error?.code === "ENOENT") {
    throw new Error("pnpm is not installed or is not available on PATH.");
  }
  if (result.status !== 0 || !existsSync(server)) {
    throw new Error("The MCP server could not be built.");
  }
}

function installHarness(harness) {
  if (!commandExists(harness.command)) {
    console.error(
      `\n✗ ${harness.label}: '${harness.command}' is not available on PATH.`,
    );
    return false;
  }

  // Remove only the user-level entry so rerunning the installer updates an old
  // absolute path without touching project/workspace configuration.
  run(harness.command, harness.removeArgs, { stdio: "ignore" });

  console.log(`\nInstalling for ${harness.label}...`);
  const result = run(harness.command, harness.addArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`✗ ${harness.label} installation failed.`);
    return false;
  }

  console.log(`✓ ${harness.label} installed at user scope.`);
  return true;
}

async function main() {
  console.log("Local Change Review MCP installer");
  console.log(`Server: ${server}\n`);

  const readline = createInterface({ input });
  const lines = readline[Symbol.asyncIterator]();
  const selected = [];
  try {
    for (const harness of harnesses) {
      if (await confirm(lines, harness.label)) selected.push(harness);
    }
  } finally {
    readline.close();
  }

  if (selected.length === 0) {
    console.log("\nNothing selected; no configuration was changed.");
    return;
  }

  try {
    compileServer();
  } catch (error) {
    console.error(`\n✗ ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const harness of selected) {
    if (!installHarness(harness)) failures += 1;
  }

  if (failures > 0) {
    console.error(`\n${failures} selected installation(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nDone. Restart the selected harnesses so they reload their MCP configuration.",
  );
  if (selected.some(({ command }) => command === "claude")) {
    console.log("Claude Code may also ask you to approve the server.");
  }
}

await main();
