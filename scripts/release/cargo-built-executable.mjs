#!/usr/bin/env node
/** Read `cargo build --message-format=json-render-diagnostics` from stdin; print the built bin path. */

const binName = process.argv[2];
if (!binName) {
  console.error("usage: cargo-built-executable.mjs <bin-name>");
  process.exit(2);
}

const lines = [];
for await (const chunk of process.stdin) {
  lines.push(...chunk.toString().split("\n"));
}

const artifacts = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (
    message.reason === "compiler-artifact" &&
    message.executable &&
    message.target?.name === binName
  ) {
    artifacts.push(message.executable);
  }
}

if (!artifacts.length) {
  console.error(`no compiler-artifact executable for bin ${binName}`);
  process.exit(1);
}

process.stdout.write(artifacts[artifacts.length - 1]);