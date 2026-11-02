import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = "scripts/dev/dotfiles-bootstrap.sh";
const defaultRepo = "https://github.com/Tyler-R-Kendrick/dotfiles.git";

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function uncommented(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

function baseEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "DOTFILES_REPO") delete env[key];
  }
  env.HOME = home;
  env.GIT_AUTHOR_NAME = "Dotfiles Test";
  env.GIT_AUTHOR_EMAIL = "dotfiles-test@example.com";
  env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  env.GIT_TERMINAL_PROMPT = "0";
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function layout(t) {
  const dir = mkdtempSync(join(tmpdir(), "dotfiles-bootstrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home dir");
  const bin = join(dir, "bin");
  mkdirSync(join(dir, "scripts/dev"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const copy = join(dir, script);
  writeFileSync(copy, read(script), { mode: 0o755 });
  return { dir, home, bin, copy };
}

function tool(bin, name, body) {
  const path = join(bin, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function installer(trace) {
  return `#!/bin/sh
set -eu
printf '%s\\n' "$0" >> ${JSON.stringify(trace)}
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\nprintf "mise fixture\\\\n"\\n' > "$HOME/.local/bin/mise"
printf '#!/bin/sh\\nprintf "grok fixture\\\\n"\\n' > "$HOME/.local/bin/grok"
chmod 755 "$HOME/.local/bin/mise" "$HOME/.local/bin/grok"
`;
}

function run(copy, env) {
  return spawnSync("bash", [copy], { env, encoding: "utf8" });
}

function assertTools(home) {
  const mise = join(home, ".local/bin/mise");
  const grok = join(home, ".local/bin/grok");
  assert.equal(statSync(mise).mode & 0o111, 0o111);
  assert.equal(statSync(grok).mode & 0o111, 0o111);
  const found = spawnSync(
    "bash",
    ["-c", "command -v mise && command -v grok && mise && grok"],
    {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${join(home, ".local/bin")}:/usr/bin:/bin`,
      },
    },
  );
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, `${mise}\n${grok}\nmise fixture\ngrok fixture\n`);
}

test("clone is anonymous HTTPS of the Tyler repo", (t) => {
  const f = layout(t);
  const trace = join(f.dir, "install-trace");
  const gitLog = join(f.dir, "git-log");
  const ghLog = join(f.dir, "gh-log");
  const installBody = installer(trace);
  tool(
    f.bin,
    "git",
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}
printf 'GIT_TERMINAL_PROMPT=%s\\n' "\${GIT_TERMINAL_PROMPT-unset}" >> ${JSON.stringify(gitLog)}
printf 'GITHUB_TOKEN=%s\\n' "\${GITHUB_TOKEN-unset}" >> ${JSON.stringify(gitLog)}
printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-unset}" >> ${JSON.stringify(gitLog)}
printf 'GH_ENTERPRISE_TOKEN=%s\\n' "\${GH_ENTERPRISE_TOKEN-unset}" >> ${JSON.stringify(gitLog)}
printf 'GITHUB_ENTERPRISE_TOKEN=%s\\n' "\${GITHUB_ENTERPRISE_TOKEN-unset}" >> ${JSON.stringify(gitLog)}
printf 'GIT_ASKPASS=%s\\n' "\${GIT_ASKPASS-unset}" >> ${JSON.stringify(gitLog)}
printf 'GIT_CONFIG_GLOBAL=%s\\n' "\${GIT_CONFIG_GLOBAL-unset}" >> ${JSON.stringify(gitLog)}
printf 'GIT_CONFIG_SYSTEM=%s\\n' "\${GIT_CONFIG_SYSTEM-unset}" >> ${JSON.stringify(gitLog)}
printf 'GIT_CONFIG_NOSYSTEM=%s\\n' "\${GIT_CONFIG_NOSYSTEM-unset}" >> ${JSON.stringify(gitLog)}
printf 'GIT_CONFIG_COUNT=%s\\n' "\${GIT_CONFIG_COUNT-unset}" >> ${JSON.stringify(gitLog)}
printf 'GIT_CONFIG_PARAMETERS=%s\\n' "\${GIT_CONFIG_PARAMETERS-unset}" >> ${JSON.stringify(gitLog)}
dest=
for arg in "$@"; do
  dest="$arg"
done
case "$*" in
  *clone*)
    mkdir -p "$dest"
    cat > "$dest/install.sh" << 'END_INSTALL'
${installBody}
END_INSTALL
    chmod 755 "$dest/install.sh"
    ;;
esac
exit 0
`,
  );
  tool(
    f.bin,
    "gh",
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\nexit 99\n`,
  );
  const env = baseEnv(f.home, {
    PATH: `${f.bin}:${process.env.PATH}`,
    GITHUB_TOKEN: "ghp_should_not_leak",
    GH_TOKEN: "ghs_should_not_leak",
    GH_ENTERPRISE_TOKEN: "ghe_should_not_leak",
    GITHUB_ENTERPRISE_TOKEN: "ghe_also_should_not_leak",
    GIT_ASKPASS: "should-not-run",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_PARAMETERS: "'credential.helper' 'store'",
  });
  delete env.GIT_TERMINAL_PROMPT;
  writeFileSync(
    join(f.home, ".gitconfig"),
    '[url "https://x-access-token:supersecret@github.com/"]\n\tinsteadOf = https://github.com/\n',
  );
  const result = run(f.copy, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(ghLog), false);
  const log = readFileSync(gitLog, "utf8");
  assert.match(log, new RegExp(defaultRepo.replaceAll(".", "\\.")));
  assert.match(log, /credential\.helper=/);
  assert.match(log, /GIT_TERMINAL_PROMPT=0/);
  assert.match(log, /GITHUB_TOKEN=unset/);
  assert.match(log, /GH_TOKEN=unset/);
  assert.match(log, /GH_ENTERPRISE_TOKEN=unset/);
  assert.match(log, /GITHUB_ENTERPRISE_TOKEN=unset/);
  assert.match(log, /GIT_ASKPASS=unset/);
  assert.match(log, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(log, /GIT_CONFIG_SYSTEM=\/dev\/null/);
  assert.match(log, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(log, /GIT_CONFIG_COUNT=unset/);
  assert.match(log, /GIT_CONFIG_PARAMETERS=unset/);
  assert.doesNotMatch(log, /ghp_should_not_leak|ghs_should_not_leak|supersecret|x-access-token/);
  assertTools(f.home);
});

test("a local clone is reused when a later refresh cannot reach the remote", (t) => {
  const f = layout(t);
  const trace = join(f.dir, "install-trace");
  const origin = join(f.dir, "origin");
  mkdirSync(join(origin, "empty"), { recursive: true });
  writeFileSync(join(origin, "install.sh"), installer(trace), { mode: 0o755 });
  const gitEnv = baseEnv(f.home, { PATH: process.env.PATH });
  execFileSync("git", ["init", "-b", "main"], { cwd: origin, env: gitEnv });
  execFileSync("git", ["add", "install.sh"], { cwd: origin, env: gitEnv });
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"],
    { cwd: origin, env: gitEnv },
  );
  const env = baseEnv(f.home, {
    PATH: process.env.PATH,
    DOTFILES_REPO: origin,
  });
  const result = run(f.copy, env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /clone failed/);
  const checkout = join(f.home, ".local/share/opensesame/tyler-dotfiles");
  assert.equal(existsSync(join(checkout, ".git")), true);
  assertTools(f.home);
  rmSync(origin, { recursive: true, force: true });
  const again = run(f.copy, env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /refresh failed; using existing checkout/);
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 2);
  assertTools(f.home);
});

test("clone failure exits 1 and keeps the previous binary", (t) => {
  const f = layout(t);
  const grok = join(f.home, ".local/bin/grok");
  mkdirSync(dirname(grok), { recursive: true });
  writeFileSync(grok, "previous\n");
  tool(f.bin, "git", "#!/bin/sh\nexit 128\n");
  tool(f.bin, "curl", "#!/bin/sh\nexit 99\n");
  tool(f.bin, "gh", "#!/bin/sh\nexit 99\n");
  const env = baseEnv(f.home, { PATH: `${f.bin}:${process.env.PATH}` });
  const missing = run(f.copy, env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /clone of .* failed/);
  assert.match(missing.stderr, /anonymous HTTPS only/);
  assert.match(missing.stderr, new RegExp(defaultRepo.replaceAll(".", "\\.")));
  assert.doesNotMatch(missing.stderr, /staging/);
  assert.equal(readFileSync(grok, "utf8"), "previous\n");
});

test("SSH and credentialed URLs are refused before git runs", (t) => {
  const f = layout(t);
  const gitLog = join(f.dir, "git-log");
  tool(
    f.bin,
    "git",
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}\nexit 0\n`,
  );
  const env = baseEnv(f.home, { PATH: `${f.bin}:${process.env.PATH}` });
  for (const url of [
    "git@github.com:Tyler-R-Kendrick/dotfiles.git",
    "ssh://git@github.com/Tyler-R-Kendrick/dotfiles.git",
    "https://x-access-token:secret@github.com/Tyler-R-Kendrick/dotfiles.git",
  ]) {
    const result = run(f.copy, { ...env, DOTFILES_REPO: url });
    assert.equal(result.status, 1, url);
    assert.match(result.stderr, /anonymous HTTPS only/);
    assert.match(result.stderr, /refusing/);
  }
  assert.equal(existsSync(gitLog), false);
});

test("bootstrap refuses a HOME it cannot write", (t) => {
  const f = layout(t);
  const missing = join(f.dir, "missing-home");
  const result = run(f.copy, baseEnv(missing, { PATH: process.env.PATH }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HOME must be a writable directory/);
});

test("script source is anonymous HTTPS with no staging fallback", () => {
  const source = uncommented(read(script));
  assert.match(source, new RegExp(defaultRepo.replaceAll(".", "\\.")));
  assert.doesNotMatch(source, /staging\/tyler-dotfiles/);
  assert.match(source, /GIT_TERMINAL_PROMPT=0/);
  assert.match(source, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(source, /GIT_CONFIG_SYSTEM=\/dev\/null/);
  assert.match(source, /credential\.helper=/);
  assert.match(source, /-u GITHUB_TOKEN/);
  assert.match(source, /-u GH_TOKEN/);
  assert.match(source, /no gh, GitHub token/);
  assert.doesNotMatch(source, /(?:^|\n)\s*gh\s/);
  assert.doesNotMatch(source, /\bgh (?:repo|auth|api)\b/);
  assert.match(source, /bash "\$\{tree\}\/install\.sh"/);
  assert.doesNotMatch(source, /\bsudo\b/);
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh/);
  const syntax = spawnSync("bash", ["-n", join(root, script)], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});
