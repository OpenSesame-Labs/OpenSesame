// kit-archive.sh pack (ADR 0212): the archive script's bytes are the same on
// every run, and a test build never ships in the kit.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const script = join(repoRootFromHere(), "scripts/release/kit-archive.sh");
const TEST_BUILD = "opensesame-surrogate-proxy-TEST-upstream-override";

// The script uses GNU tar's --sort, --mtime and --owner; macOS ships bsdtar.
const gnuTar = /GNU tar/.test(
  spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "",
);

describe.skipIf(!gnuTar)(
  gnuTar
    ? "kit-archive.sh"
    : "kit-archive.sh (skipped: tar here is not GNU tar, which the script needs)",
  () => {
    let work;
    let bins;
    let bridge;
    const put = (name, text) => {
      writeFileSync(join(bins, name), text);
      chmodSync(join(bins, name), 0o755);
    };
    beforeAll(() => {
      work = mkdtempSync(join(tmpdir(), "kit-archive-"));
      bins = join(work, "bins");
      mkdirSync(bins);
      put("opensesame", "stand-in for opensesame\n");
      put("opensesame-surrogate-proxy", "plugin_not_active\n");
      put(TEST_BUILD, "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
      bridge = join(work, "opensesame-env-parse.mjs");
      writeFileSync(bridge, "#!/usr/bin/env node\n");
    });
    afterAll(() => rmSync(work, { recursive: true, force: true }));
    const env = { ...process.env, SOURCE_DATE_EPOCH: "1760000000" };
    const target = "x86_64-unknown-linux-gnu";

    const pack = (out, umask) =>
      spawnSync(
        "bash",
        [
          "-c",
          `umask ${umask} && exec "$0" "$@"`,
          script,
          "pack",
          "v0.1.0",
          target,
          bins,
          bridge,
          out,
        ],
        { env, encoding: "utf8" },
      );

    it("packs the same bytes twice, whatever the umask", () => {
      const outs = ["022", "077"].map((umask) => {
        const out = join(work, `out-${umask}`);
        expect(pack(out, umask).status).toBe(0);
        writeFileSync(
          join(out, "opensesame-env-parse.mjs"),
          readFileSync(bridge),
        );
        execFileSync("bash", [script, "sums", out], { env });
        return out;
      });
      const files = readdirSync(outs[0]).sort();
      expect(files).toEqual([
        "SHA256SUMS",
        "opensesame-env-parse.mjs",
        `opensesame-kit_v0.1.0_${target}.tar.gz`,
        `${TEST_BUILD}_v0.1.0_${target}.tar.gz`,
      ]);
      for (const file of files) {
        expect(readFileSync(join(outs[1], file))).toEqual(
          readFileSync(join(outs[0], file)),
        );
      }
      const listing = execFileSync(
        "tar",
        ["-tvzf", join(outs[0], `opensesame-kit_v0.1.0_${target}.tar.gz`)],
        { encoding: "utf8" },
      );
      expect(listing).toMatch(
        /^-rw-r--r-- 0\/0 .* opensesame-kit_v0\.1\.0_[^/]+\/opensesame-env-parse\.mjs$/m,
      );
      expect(listing).toMatch(
        /^-rwxr-xr-x 0\/0 .* opensesame-kit_v0\.1\.0_[^/]+\/opensesame$/m,
      );
      expect(listing).not.toContain(TEST_BUILD);
    });

    it("refuses a shipped plugin carrying the override, and a test build without it", () => {
      put("opensesame-surrogate-proxy", "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
      const shipped = pack(join(work, "refused-a"), "022");
      expect(shipped.status).toBe(2);
      expect(shipped.stderr).toContain("a test build is not shipped");
      put("opensesame-surrogate-proxy", "plugin_not_active\n");
      put(TEST_BUILD, "plugin_not_active\n");
      const test = pack(join(work, "refused-b"), "022");
      expect(test.status).toBe(2);
      expect(test.stderr).toContain("it is not the upstream-override build");
      put(TEST_BUILD, "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
    });

    it.skipIf(
      process.platform !== "linux" || !["x64", "arm64"].includes(process.arch),
    )("smokes a kit when node is a version-manager shim", () => {
      const area = join(work, "smoke");
      const targetArch = process.arch === "arm64" ? "aarch64" : "x86_64";
      const name = `opensesame-kit_v0.1.0_${targetArch}-unknown-linux-gnu`;
      const kit = join(area, name);
      const shim = join(area, "shim");
      mkdirSync(kit, { recursive: true });
      mkdirSync(shim);
      writeFileSync(
        join(shim, "mise"),
        [
          "#!/bin/sh",
          'if [ "${0##*/}" != node ]; then echo "shim invoked as mise" >&2; exit 1; fi',
          'exec "$REAL_NODE" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      symlinkSync("mise", join(shim, "node"));
      writeFileSync(
        join(kit, "opensesame"),
        [
          "#!/bin/sh",
          '[ "$1" = --version ] && { echo "opensesame 0.1.0"; exit; }',
          'bridge="$(dirname "$0")/opensesame-env-parse.mjs"',
          'case "$(stat -c %a "$bridge")" in',
          "  644) ;;",
          '  666) echo "writable by others" >&2; exit 1 ;;',
          '  *) echo "unexpected bridge mode" >&2; exit 1 ;;',
          "esac",
          'exec "$OPENSESAME_NODE" "$bridge"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        join(kit, "opensesame-env-parse.mjs"),
        'console.log(JSON.stringify({ items: [{ key: "WORKOS_API_KEY" }] }));\n',
      );
      const archive = join(area, `${name}.tar.gz`);
      execFileSync("tar", ["-czf", archive, "-C", area, name]);
      const smoke = spawnSync(
        "bash",
        [join(repoRootFromHere(), "scripts/release/smoke-kit.sh"), archive],
        {
          cwd: area,
          env: {
            ...process.env,
            PATH: `${shim}:${process.env.PATH}`,
            REAL_NODE: process.execPath,
          },
          encoding: "utf8",
        },
      );
      expect({ status: smoke.status, stderr: smoke.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(smoke.stdout).toContain("writable by others");
    });
  },
);
