// Contract for the container scans in .github/workflows/security.yml: the
// source images are built exactly as the proof workflow builds them, the
// historical registry tags are scanned while they exist, and a deleted tag
// closes its findings with an empty report instead of failing or going stale.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = (name) =>
  parse(readFileSync(join(root, ".github/workflows", name), "utf8"));
const security = workflow("security.yml").jobs;
const proof = workflow("cd-ghcr-publish.yml").jobs;

const isScan = (step) =>
  String(step.uses ?? "").startsWith("google/osv-scanner-action/");
const byName = (steps, name) => steps.find((step) => step.name === name);
const lines = (text) =>
  String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
/** Any parsed YAML value with each `${{ key }}` in `values` substituted. */
const fill = (data, values) =>
  JSON.parse(
    JSON.stringify(data).replace(/\$\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) =>
      key in values ? values[key] : whole,
    ),
  );

/** Every proof build as concrete inputs: what Docker is given, per row. */
function proofBuilds() {
  const resolve = (job, row) => {
    const steps = job.steps;
    const tags = byName(steps, "Image tags");
    assert.match(tags.run, /echo "version=0\.0\.0-local"/);
    const name = row?.name ?? tags.env.IMAGE_NAME;
    const values = {
      "steps.tags.outputs.version": "0.0.0-local",
      "steps.tags.outputs.list": `${name}:local`,
      ...Object.fromEntries(
        Object.entries(row ?? {}).map(([key, value]) => [
          `matrix.${key}`,
          value,
        ]),
      ),
    };
    const build = Object.fromEntries(
      Object.entries(byName(steps, "Build").with)
        .filter(([key]) => key !== "cache-to")
        .map(([key, value]) => [key, fill(value, values)]),
    );
    return {
      id: row?.id ?? job.name,
      image: name,
      runner: fill(job["runs-on"], values),
      checkout: lines(steps[0].with["sparse-checkout"]),
      build,
    };
  };
  return [
    ...proof.images.strategy.matrix.include.map((row) =>
      resolve(proof.images, row),
    ),
    resolve(proof["opensesame-amd64"]),
    resolve(proof["web-pwa-amd64"]),
  ];
}

/** Every source-scan row as concrete inputs, in the same shape. */
function sourceBuilds() {
  const job = security["container-sources"];
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  return job.strategy.matrix.include.map((row) => {
    const values = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [`matrix.${key}`, value]),
    );
    const build = Object.fromEntries(
      Object.entries(byName(job.steps, "Build").with)
        .map(([key, value]) => [key, fill(value, values)])
        .filter(([key, value]) => !(key === "target" && value === "")),
    );
    return {
      id: row.id,
      image: row.image,
      runner: fill(job["runs-on"], values),
      checkout: lines(fill(job.steps[0].with["sparse-checkout"], values)),
      build,
    };
  });
}

const sortById = (rows) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

test("every proof image is built from current source exactly as the proof builds it", () => {
  const proofRows = proofBuilds();
  assert.equal(proofRows.length, 6);
  // Same ids (cache scopes), images, runners, checkout and Docker inputs;
  // only the cache write is absent.
  assert.deepEqual(sortById(sourceBuilds()), sortById(proofRows));
  for (const { build } of sourceBuilds()) {
    assert.equal(build.push, false);
    assert.equal(build["cache-to"], undefined);
  }
});

/**
 * A proof preparation job as this workflow runs it: the commit pinned on the
 * checkout, the locked mise bootstrap replaced by this workflow's mise-action
 * step, and the shared Rust cache restored but never saved.
 */
function asScanned(steps, tool) {
  const expected = structuredClone(steps);
  expected[0].with = { ref: "${{ github.sha }}", ...expected[0].with };
  const restore = expected.findIndex(
    (step) => step.name === "Restore mise tool cache",
  );
  assert.match(expected[restore + 1].run, /install-mise-locked\.sh /);
  const mise = security["patched-dependencies"].steps.find((step) =>
    String(step.uses).startsWith("jdx/mise-action@"),
  );
  expected.splice(restore, 2, {
    uses: mise.uses,
    with: { cache: true, install_args: tool },
  });
  const cache = expected.find((step) => step.id === "rust-cache-ghcr");
  if (cache) cache.with["save-if"] = false;
  return expected;
}

test("the inputs the proof prepares outside Docker are prepared by the same steps", () => {
  assert.deepEqual(
    security["container-sources-web-pwa-tailscale-wasm"].steps,
    asScanned(proof["web-pwa-tailscale-wasm"].steps, "node"),
  );
  assert.deepEqual(
    security["container-sources-opensesame-amd64-rust"].steps,
    asScanned(proof["opensesame-amd64-rust"].steps, "rust"),
  );
  for (const id of [
    "container-sources-web-pwa-tailscale-wasm",
    "container-sources-opensesame-amd64-rust",
  ])
    assert.deepEqual(security[id].permissions, {
      contents: "read",
      actions: "read",
    });
});

test("each source image is scanned, checked and uploaded under its own category", () => {
  const job = security["container-sources"];
  assert.deepEqual(job.permissions, {
    contents: "read",
    actions: "read",
    "security-events": "write",
  });
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.if, "${{ !cancelled() }}");
  const steps = job.steps;
  for (const step of steps)
    assert.equal(
      /docker (run|exec|create|start|push|login)\b/.test(step.run ?? ""),
      false,
    );
  assert.match(
    byName(steps, "Save the image for the scanner").run,
    /^docker save --output image\.tar "\$IMAGE"\n/,
  );
  const scan = steps.findIndex(isScan);
  const historical = security["container-images"].steps.find(isScan);
  assert.deepEqual(steps[scan].with, historical.with);
  assert.equal(steps[scan].uses, historical.uses);
  assert.equal(steps[scan]["continue-on-error"], true);
  const check = steps[scan + 1];
  assert.match(
    check.run,
    /^node scripts\/security\/sarif-summary\.mjs image\.sarif /,
  );
  assert.equal(check["continue-on-error"], undefined);
  assert.equal(check.if, undefined);
  const upload = steps[scan + 2];
  assert.equal(upload.with.sarif_file, "image.sarif");
  assert.equal(
    upload.with.category,
    "container-source-${{ matrix.image }}-${{ matrix.arch }}",
  );
});

test("the historical tags cover every proof image and platform", () => {
  const job = security["container-images"];
  const targets = proofBuilds().map(
    ({ image, build }) => `${image}/${build.platforms.replace("linux/", "")}`,
  );
  const listed = job.strategy.matrix.target.map(
    ({ image, arch }) => `${image}/${arch}`,
  );
  assert.deepEqual(listed.sort(), targets.sort());
  assert.deepEqual(job.strategy.matrix.tag, ["next", "latest"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.permissions, {
    contents: "read",
    packages: "read",
    "security-events": "write",
  });
  assert.equal(job.env.ARCH, "${{ matrix.target.arch }}");
});

test("a deleted tag, next or latest, uploads an empty report; any other error fails", () => {
  const steps = security["container-images"].steps;
  const pull = steps.find((step) => step.id === "pull").run;
  // Pulled and saved by the platform image's own digest, never by tag.
  assert.match(pull, /docker pull --quiet "\$IMAGE@\$digest"/);
  assert.match(pull, /docker save --output image\.tar "\$IMAGE@\$digest"/);
  assert.match(
    pull,
    /select\(\.platform\.os == "linux" and \.platform\.architecture == \$arch\)/,
  );
  assert.match(pull, /publishes no linux\/\$ARCH image"\n\s*exit 1/);
  assert.equal(/docker (run|exec|create|start)\b/.test(pull), false);
  assert.match(pull, /--password-stdin/);
  assert.match(pull, /trap 'docker logout ghcr\.io' EXIT/);
  const tolerated = pull.slice(
    pull.indexOf("if ! listing="),
    pull.indexOf("# The tag names a list"),
  );
  // Only "no such manifest" excuses a row, and for either tag.
  assert.equal(
    tolerated.includes(
      `if grep -Eqi 'manifest unknown|no such manifest' <<<"$listing"; then`,
    ),
    true,
  );
  assert.equal(/\$TAG"? *=/.test(tolerated), false);
  // A bare "not found" would also excuse "command not found".
  assert.equal(/not found'/.test(tolerated), false);
  assert.match(tolerated, /published=false/);
  assert.match(tolerated, /exit 1\n\s*fi\n$/);

  const scan = steps.findIndex(isScan);
  assert.equal(steps[scan].if, "steps.pull.outputs.published == 'true'");
  assert.equal(steps[scan]["continue-on-error"], true);
  assert.deepEqual(steps[scan].with["scan-args"].split("\n"), [
    "scan",
    "image",
    "--archive",
    "--format=sarif",
    "--output-file=image.sarif",
    "image.tar",
  ]);
  const empty = steps[scan + 1];
  assert.equal(empty.if, "steps.pull.outputs.published == 'false'");
  assert.match(
    empty.run,
    /^node scripts\/security\/empty-sarif\.mjs image\.sarif\n/,
  );
  assert.match(empty.run, /GITHUB_STEP_SUMMARY/);
  // Both paths reach the same report check and the same category.
  const check = steps[scan + 2];
  assert.match(
    check.run,
    /^node scripts\/security\/sarif-summary\.mjs image\.sarif /,
  );
  assert.equal(check.if, undefined);
  assert.equal(check["continue-on-error"], undefined);
  const upload = steps[scan + 3];
  assert.match(
    upload.uses,
    /^github\/codeql-action\/upload-sarif@[a-f0-9]{40}$/,
  );
  assert.equal(upload.if, undefined);
  assert.equal(upload.with.sarif_file, "image.sarif");
  assert.equal(
    upload.with.category,
    "container-image-${{ matrix.target.image }}-${{ matrix.tag }}-${{ matrix.target.arch }}",
  );
});

test("the dev container image is built from its definition and scanned the same way", () => {
  const job = security["devcontainer-image"];
  assert.deepEqual(job.permissions, {
    contents: "read",
    "security-events": "write",
  });
  const steps = job.steps;
  const build = steps[1].run;
  assert.match(
    build,
    /docker build .*--file \.devcontainer\/Dockerfile .*\.devcontainer\n/,
  );
  assert.match(build, /docker save --output image\.tar /);
  assert.equal(
    /docker (run|exec|create|start|push|login)\b/.test(build),
    false,
  );
  const images = security["container-images"].steps;
  // Same scanner, same arguments, same tolerance as the published images.
  assert.deepEqual(steps.find(isScan).with, images.find(isScan).with);
  assert.equal(steps.find(isScan).uses, images.find(isScan).uses);
  assert.equal(steps.find(isScan)["continue-on-error"], true);
  const check = steps[steps.findIndex(isScan) + 1];
  assert.match(
    check.run,
    /^node scripts\/security\/sarif-summary\.mjs image\.sarif /,
  );
  assert.equal(check["continue-on-error"], undefined);
  assert.equal(check.if, undefined);
  assert.equal(steps.at(-1).with.category, "container-image-devcontainer");
});
