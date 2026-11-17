import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/audit"))
from cve_lite_phantoms import proven_indirect_import


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class PhantomProofTests(unittest.TestCase):
    def setUp(self):
        typescript = ROOT / "apps/pages/node_modules/typescript"
        if not (typescript / "package.json").is_file():
            self.skipTest("install the Pages workspace dependencies")
        self.tmp = tempfile.TemporaryDirectory(prefix="cve-lite-phantom-")
        self.root = Path(self.tmp.name)
        write_json(self.root / "apps/pages/package.json", {"name": "pages"})
        (self.root / "apps/pages/node_modules").mkdir()
        (self.root / "apps/pages/node_modules/typescript").symlink_to(typescript, target_is_directory=True)
        manifest = {"name": "app-core", "devDependencies": {"esbuild": "0.28.2"},
                    "dependencies": {"effect": "4.1.2"}}
        write_json(self.root / "packages/app-core/package.json", manifest)
        self.lock = {"packages": {"packages/app-core": manifest}}
        for name, version in (("esbuild", "0.28.2"), ("effect", "4.1.2")):
            path = f"node_modules/{name}"
            write_json(self.root / path / "package.json", {"name": name, "version": version})
            self.lock["packages"][path] = {"version": version}

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def source(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def test_require_must_resolve_from_declaring_app_core_package(self):
        path = "scripts/test/probe.mjs"
        source = '''import { createRequire } from "node:module";
import { resolve } from "node:path";
function load(root) {
  const require = createRequire(resolve(root, "packages/app-core/package.json"));
  return require("esbuild");
}'''
        self.source(path, source)
        self.assertTrue(proven_indirect_import(self.root, self.lock, "esbuild", path))
        self.source(path, source + '\nimport "esbuild";')
        self.assertFalse(proven_indirect_import(self.root, self.lock, "esbuild", path))
        self.source(path, source.replace("packages/app-core/package.json", "apps/pages/package.json"))
        self.assertFalse(proven_indirect_import(self.root, self.lock, "esbuild", path))
        self.source(path, source.replace("function load(root)", "function load(root, createRequire)"))
        self.assertFalse(proven_indirect_import(self.root, self.lock, "esbuild", path))
        self.source(path, source + '\nglobalThis.eval("0");')
        self.assertFalse(proven_indirect_import(self.root, self.lock, "esbuild", path))
        self.source(path, source)
        self.lock["packages"]["node_modules/esbuild"]["version"] = "0.25.0"
        self.assertFalse(proven_indirect_import(self.root, self.lock, "esbuild", path))

    def test_embedded_bundle_requires_app_core_resolver_and_declared_packages(self):
        path = "scripts/test/bundle.mjs"
        source = '''import { createRequire } from "node:module";
import path from "node:path";
function providerS3Esbuild(root) {
  const require = createRequire(path.join(root, "packages/app-core/package.json"));
  return require("esbuild");
}
function signer(root) {
  const esbuild = providerS3Esbuild(root);
  return esbuild.build({stdin: {resolveDir: path.join(root, "packages/app-core"),
    contents: `import { Redacted } from "effect";`}});
}'''
        self.source(path, source)
        self.assertTrue(proven_indirect_import(self.root, self.lock, "effect", path))
        self.source(path, source.replace('path.join(root, "packages/app-core"),', 'path.join(root, "apps/pages"),'))
        self.assertFalse(proven_indirect_import(self.root, self.lock, "effect", path))
        self.source(path, source.replace('return require("esbuild");', 'return require("other");'))
        self.assertFalse(proven_indirect_import(self.root, self.lock, "effect", path))
        self.source(path, source + "\nfunction shadow(providerS3Esbuild) {}")
        self.assertFalse(proven_indirect_import(self.root, self.lock, "effect", path))
        self.source(path, source)
        del self.lock["packages"]["packages/app-core"]["devDependencies"]["esbuild"]
        self.assertFalse(proven_indirect_import(self.root, self.lock, "effect", path))

    def test_analyzer_fixture_is_data_and_reviewed_analyzer_must_match(self):
        path = "scripts/lib/app-core-boundary.test.mjs"
        self.source(path, '''import { findViolations } from "./app-core-boundary.mjs";
const files = new Map([["src/test.ts", 'import { waitFor } from "@testing-library/react";']]);
findViolations(files, {});''')
        target = self.root / "scripts/lib/app-core-boundary.mjs"
        shutil.copyfile(ROOT / "scripts/lib/app-core-boundary.mjs", target)
        self.assertTrue(proven_indirect_import(self.root, self.lock, "@testing-library/react", path))
        fixture = self.root / path
        original = fixture.read_text()
        fixture.write_text(original + "\nrun(files);\n")
        self.assertFalse(proven_indirect_import(self.root, self.lock, "@testing-library/react", path))
        fixture.write_text(original)
        target.write_text(target.read_text() + "\n// changed analyzer\n")
        self.assertFalse(proven_indirect_import(self.root, self.lock, "@testing-library/react", path))


if __name__ == "__main__":
    unittest.main()
