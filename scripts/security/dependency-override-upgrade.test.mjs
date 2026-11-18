// scripts/security/dependency-override-upgrade.test.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";

test("the actual Rollup resolver selects package exports with the supported deepmerge", async () => {
  const temp = await mkdtemp(join(tmpdir(), "opensesame-node-resolve-"));
  try {
    const dependency = join(temp, "node_modules", "resolver-fixture");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "resolver-fixture",
        type: "module",
        exports: {
          ".": { browser: "./browser.js", default: "./default.js" },
        },
      }),
    );
    await writeFile(
      join(dependency, "browser.js"),
      'export default "browser-export";\n',
    );
    await writeFile(
      join(dependency, "default.js"),
      'export default "default-export";\n',
    );
    const entry = join(temp, "index.js");
    await writeFile(
      entry,
      'import value from "resolver-fixture"; export { value };\n',
    );
    const bundle = await rollup({
      input: entry,
      plugins: [nodeResolve({ browser: true })],
    });
    try {
      const { output } = await bundle.generate({ format: "es" });
      assert.match(output[0].code, /browser-export/);
      assert.doesNotMatch(output[0].code, /default-export/);
    } finally {
      await bundle.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// scripts/security/dependency-edge-compatibility.test.mjs
import assert2 from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { connect } from "node:net";
import { dirname, join as join2, resolve as resolve2 } from "node:path";
import { test as test2 } from "node:test";

var root2 = resolve2(import.meta.dirname, "../..");
var require2 = createRequire2(import.meta.url);
var lock = JSON.parse(readFileSync(join2(root2, "package-lock.json"), "utf8"));
var manifest = JSON.parse(readFileSync(join2(root2, "package.json"), "utf8"));
var packageAt = (path) => lock.packages[path];
test2(
  "Noble consumers resolve compatible reviewed primitive versions",
  async () => {
    const exact20Consumers = [
      "node_modules/@scure/bip32/node_modules/@noble/curves",
      "node_modules/@scure/bip32/node_modules/@noble/hashes",
      "node_modules/@scure/bip39/node_modules/@noble/hashes",
      "node_modules/nostr-tools/node_modules/@noble/curves",
      "node_modules/nostr-tools/node_modules/@noble/hashes",
    ];
    for (const path of exact20Consumers)
      assert2.equal(packageAt(path)?.version, "2.0.1", path);
    const postQuantum = packageAt("node_modules/@noble/post-quantum");
    assert2.equal(
      postQuantum.resolved,
      "file:patches/vendor/noble-post-quantum-0.5.4.tgz",
    );
    assert2.deepEqual(postQuantum.dependencies, {
      "@noble/curves": "2.4.0",
      "@noble/hashes": "2.4.0",
    });
    const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
    const keys = ml_kem768.keygen();
    const encapsulated = ml_kem768.encapsulate(keys.publicKey);
    assert2.deepEqual(
      ml_kem768.decapsulate(encapsulated.cipherText, keys.secretKey),
      encapsulated.sharedSecret,
    );
    const { HDKey } = await import("@scure/bip32");
    assert2.equal(
      HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/0'/1")
        .publicKey.length,
      33,
    );
    const { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } =
      await import("nostr-tools");
    const secret = generateSecretKey();
    const event = finalizeEvent(
      { kind: 1, created_at: 1, tags: [], content: "compatibility" },
      secret,
    );
    assert2.equal(event.pubkey, getPublicKey(secret));
    assert2.equal(verifyEvent(event), true);
  },
);
test2(
  "node-turn declares and loads the fixed YAML and logging releases",
  () => {
    const turn = packageAt("node_modules/node-turn");
    assert2.equal(turn.resolved, "file:patches/vendor/node-turn-0.0.6.tgz");
    assert2.deepEqual(turn.dependencies, {
      crc: "~3.8.0",
      "js-yaml": "3.15.2",
      log4js: "6.4.0",
    });
    const turnRequire = createRequire2(require2.resolve("node-turn"));
    assert2.equal(
      turnRequire("js-yaml").safeLoad("enabled: true").enabled,
      true,
    );
    assert2.equal(
      typeof turnRequire("log4js").getLogger("turn").info,
      "function",
    );
    assert2.equal(typeof turnRequire("node-turn"), "function");
  },
);
function rawRequest(port, target) {
  return new Promise((resolveResponse, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolveResponse(response));
    socket.once("connect", () => {
      socket.end(`GET ${target} HTTP/1.1\r
Host: localhost\r
Connection: close\r
\r
`);
    });
  });
}
test2(
  "Promptfoo uses genuine fixed Hono and keeps its CJS and ESM APIs",
  async () => {
    const promptfooLock = packageAt("node_modules/promptfoo");
    const honoLock = packageAt("node_modules/@hono/node-server");
    assert2.equal(promptfooLock.version, "0.125.1");
    assert2.equal(
      promptfooLock.resolved,
      "https://registry.npmjs.org/promptfoo/-/promptfoo-0.125.1.tgz",
    );
    assert2.equal(
      promptfooLock.integrity,
      "sha512-nogBhixdp69icwkg1EI0syZ4zAmAjJyWeLcqxAkTldbHi0qirOslwHvkUQhQmg65lQLrIKyMOMLXlBlSc6LRrg==",
    );
    assert2.equal(manifest.overrides.promptfoo["@hono/node-server"], "2.1.6");
    assert2.equal(honoLock.version, "2.1.6");
    assert2.equal(
      honoLock.resolved,
      "https://registry.npmjs.org/@hono/node-server/-/node-server-2.1.6.tgz",
    );
    assert2.equal(
      honoLock.integrity,
      "sha512-p/KH9MnfNcsm3sR6x4lNgm5j+QN4Et8srKredl9DZfXiyZ1UQ3aQ2YVpFLbqktYN5JI+DB+VZFKM2PqE5hLKjQ==",
    );
    assert2.equal(
      packageAt("node_modules/promptfoo/node_modules/@hono/node-server"),
      void 0,
    );
    assert2.equal(
      packageAt("node_modules/promptfoo").dependencies.zod,
      "4.6.7",
    );
    assert2.equal(packageAt("node_modules/zod").version, "4.6.7");
    const promptfooRequire = createRequire2(require2.resolve("promptfoo"));
    const honoEntry = promptfooRequire.resolve("@hono/node-server");
    const honoPackage = JSON.parse(
      readFileSync(join2(dirname(dirname(honoEntry)), "package.json"), "utf8"),
    );
    assert2.equal(honoPackage.version, "2.1.6");
    const cjs = promptfooRequire("promptfoo");
    const esm = await import("promptfoo");
    assert2.equal(typeof cjs.evaluate, "function");
    assert2.equal(typeof esm.evaluate, "function");
    assert2.deepEqual(
      cjs.AssertionSchema.parse({ type: "equals", value: "ok" }),
      {
        type: "equals",
        value: "ok",
      },
    );
    const { createAdaptorServer } = promptfooRequire("@hono/node-server");
    const server = createAdaptorServer({
      fetch: (request) => new Response(request.url),
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const { port } = server.address();
      assert2.match(
        await rawRequest(port, "/ordinary/path"),
        /^HTTP\/1\.1 200 /,
      );
      assert2.match(
        await rawRequest(port, "/safe\\..\\admin"),
        /^HTTP\/1\.1 400 /,
      );
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  },
);
test2(
  "the audited edge set has only Promptfoo's explicit safe override",
  () => {
    const promptfoo = packageAt("node_modules/promptfoo");
    assert2.equal(promptfoo.version, "0.125.1");
    assert2.equal(promptfoo.dependencies["@hono/node-server"], "2.1.5");
    assert2.equal(manifest.overrides.promptfoo["@hono/node-server"], "2.1.6");
    assert2.equal(packageAt("node_modules/@hono/node-server").version, "2.1.6");
    assert2.equal(
      promptfoo.dependencies.zod,
      packageAt("node_modules/zod").version,
    );
    assert2.equal(
      packageAt("node_modules/node-turn").dependencies["js-yaml"],
      packageAt("node_modules/js-yaml").version,
    );
    assert2.equal(
      packageAt("node_modules/node-turn").dependencies.log4js,
      packageAt("node_modules/log4js").version,
    );
  },
);

// scripts/security/glob-backport-sourcemaps.test.mjs
import assert3 from "node:assert/strict";
import { readFileSync as readFileSync2 } from "node:fs";
import { SourceMap, createRequire as createRequire3 } from "node:module";
import {
  dirname as dirname2,
  join as join3,
  resolve as resolve3,
} from "node:path";
import { test as test3 } from "node:test";

var root3 = resolve3(import.meta.dirname, "../..");
function originalLine(file, needle) {
  const lines = readFileSync2(file, "utf8").split("\n");
  const line = lines.findIndex((item) => item.includes(needle));
  assert3.notEqual(line, -1, `${needle} missing from ${file}`);
  const map = JSON.parse(readFileSync2(`${file}.map`, "utf8"));
  const mapping = new SourceMap(map).findEntry(
    line,
    lines[line].indexOf(needle),
  );
  assert3.equal(typeof mapping.originalLine, "number");
  return map.sourcesContent[0].split("\n")[mapping.originalLine];
}
test3(
  "backported glob and minimatch source maps show the changed guard",
  () => {
    for (const consumer of ["archiver-utils", "workbox-build"]) {
      const local = createRequire3(
        join3(root3, "node_modules", consumer, "package.json"),
      );
      const glob = local.resolve("glob");
      const matcher = createRequire3(glob).resolve("minimatch");
      const globRoot = dirname2(dirname2(dirname2(glob)));
      const matcherRoot = dirname2(dirname2(dirname2(matcher)));
      for (const format of ["commonjs", "esm"]) {
        const walker = join3(globRoot, "dist", format, "walker.js");
        const index = join3(matcherRoot, "dist", format, "index.js");
        assert3.match(originalLine(walker, "return cb()"), /return cb\(\)/);
        assert3.match(
          originalLine(index, "globParts.length <= 1000"),
          /globParts\.length <= 1000/,
        );
      }
    }
  },
);

// scripts/security/minimatch-consumer-compatibility.test.mjs
import assert4 from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync as readFileSync3,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire as createRequire4 } from "node:module";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join4 } from "node:path";
import { test as test4 } from "node:test";

var require3 = createRequire4(import.meta.url);
var readdirGlob = require3("readdir-glob");
var { FileList } = require3("filelist");
test4(
  "both consumers resolve the fixed 5.x matcher and 2.x brace expansion",
  () => {
    for (const consumer of ["filelist", "readdir-glob"]) {
      const local = createRequire4(require3.resolve(consumer));
      const minimatchPath = local.resolve("minimatch/package.json");
      const minimatch = JSON.parse(readFileSync3(minimatchPath, "utf8"));
      const bracePath = createRequire4(minimatchPath).resolve(
        "brace-expansion/package.json",
      );
      const brace = JSON.parse(readFileSync3(bracePath, "utf8"));
      assert4.equal(minimatch.version, "5.1.9");
      assert4.equal(brace.version, "2.1.8");
    }
  },
);
function fixture() {
  const root4 = mkdtempSync(join4(tmpdir2(), "glob-consumer-"));
  mkdirSync(join4(root4, "a"));
  mkdirSync(join4(root4, "src"));
  writeFileSync(join4(root4, "a", "b"), "content");
  writeFileSync(join4(root4, "src", "a.js"), "content");
  writeFileSync(join4(root4, "src", "a.test.js"), "content");
  writeFileSync(join4(root4, "src", "notes.md"), "content");
  return root4;
}
function read(root4, options) {
  return new Promise((resolve4, reject) => {
    readdirGlob(root4, options, (error, paths) => {
      if (error) reject(error);
      else resolve4(paths.sort());
    });
  });
}
test4(
  "readdir-glob retains minimatch 5 behavior for noglobstar and parent segments",
  async () => {
    const root4 = fixture();
    try {
      assert4.deepEqual(
        await read(root4, {
          pattern: "a/**/../b",
          noglobstar: true,
          nodir: true,
        }),
        [],
      );
      assert4.deepEqual(
        await read(root4, {
          pattern: ["**/*.js", "**/*.md"],
          ignore: "**/*.test.js",
          nodir: true,
        }),
        ["src/a.js", "src/notes.md"],
      );
    } finally {
      rmSync(root4, { recursive: true, force: true });
    }
  },
);
test4(
  "filelist still includes and excludes matches with the compatible matcher",
  () => {
    const root4 = fixture();
    const previous = process.cwd();
    try {
      process.chdir(root4);
      const list = new FileList();
      list.include("src/**/*.{js,md}").exclude("**/*.test.js");
      assert4.deepEqual(list.toArray().sort(), ["src/a.js", "src/notes.md"]);
    } finally {
      process.chdir(previous);
      rmSync(root4, { recursive: true, force: true });
    }
  },
);
