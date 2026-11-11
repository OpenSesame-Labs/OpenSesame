import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const readJson = (file) =>
  JSON.parse(readFileSync(path.join(root, file), "utf8"));
const manifest = readJson("package.json");
const lock = readJson("package-lock.json");
const edges = ["dependencies", "optionalDependencies", "peerDependencies"];

/** Every copy of `name` the lockfile installs, hoisted or nested. */
function copies(name) {
  return Object.keys(lock.packages).filter((key) =>
    key.endsWith(`node_modules/${name}`),
  );
}

/** Every locked package that still asks for `name`. */
function dependents(name) {
  return Object.entries(lock.packages)
    .filter(([, entry]) =>
      edges.some((field) => Object.hasOwn(entry[field] ?? {}, name)),
    )
    .map(([key]) => key);
}

/** The installed copy itself, never whichever copy a bare name resolves to. */
function load(key) {
  const copy = createRequire(path.join(root, key, "package.json"));
  return { version: copy("./package.json").version, exports: copy("./") };
}

const quoteCopies = copies("shell-quote");
const mapCopies = copies("source-map-js");

// WXT 0.21 no longer installs web-ext-run, whose fx-runner was the last
// consumer of shell-quote. The pin stays, so a consumer that returns cannot
// bring the vulnerable release back, and each copy it installs is exercised.
test("shell-quote is absent or pinned to the release that fixes comment escapes", () => {
  assert.equal(manifest.overrides["shell-quote"], "1.11.0");
  for (const key of quoteCopies) {
    assert.equal(lock.packages[key].version, "1.11.0", key);
  }
  if (quoteCopies.length > 0) return;
  assert.deepEqual(dependents("shell-quote"), []);
  assert.throws(
    () => createRequire(path.join(root, "package.json")).resolve("shell-quote"),
    { code: "MODULE_NOT_FOUND" },
  );
});

for (const key of quoteCopies) {
  test(`shell-quote refuses a later token that escapes a comment through a line terminator (${key})`, () => {
    const { version, exports } = load(key);
    assert.equal(version, "1.11.0");
    const { quote } = exports;
    for (const terminator of ["\n", "\r", " ", " "]) {
      assert.throws(
        () => quote(["echo", "ok", { comment: "x" }, `a${terminator}id;#`]),
        { name: "TypeError" },
      );
    }
    assert.equal(quote(["echo", "hello world"]), "echo 'hello world'");
    assert.equal(
      quote(["echo", "ok", { comment: "ordinary" }]),
      "echo ok #ordinary",
    );
  });
}

function indexed(line) {
  return {
    version: 3,
    sections: [
      {
        offset: { line, column: 0 },
        map: {
          version: 3,
          sources: ["a.js"],
          sourcesContent: ["hello"],
          names: [],
          mappings: "AAAA",
        },
      },
    ],
  };
}

test("source-map-js is installed at the root as the fixed release", () => {
  assert.equal(manifest.overrides["source-map-js"], "1.2.2");
  assert.ok(mapCopies.includes("node_modules/source-map-js"));
});

for (const key of mapCopies) {
  test(`source-map-js rejects the oversized section before synchronous SourceNode iteration (${key})`, () => {
    const { version, exports } = load(key);
    assert.equal(version, "1.2.2");
    const { SourceMapConsumer, SourceNode } = exports;
    assert.throws(
      () => new SourceMapConsumer(indexed(1e12)),
      /Section offset line must not exceed/,
    );
    const consumer = new SourceMapConsumer(indexed(2));
    const source = SourceNode.fromStringWithSourceMap(
      "one\ntwo\nhello",
      consumer,
    );
    assert.equal(source.toString(), "one\ntwo\nhello");
  });
}
