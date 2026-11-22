#!/usr/bin/env python3
"""Exercise scratch snapshots without touching the working repository."""
import json
from pathlib import Path
import subprocess
import tempfile


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.DEVNULL)


def main() -> None:
    script = Path(__file__).with_name("negative-controls.py")
    module = {"__name__": "snapshot_test", "__file__": str(script)}
    exec(compile(script.read_bytes(), str(script), "exec", dont_inherit=True), module)
    with tempfile.TemporaryDirectory(prefix="opensesame-peer-snapshot-") as directory:
        base = Path(directory)
        repo = base / "repo"
        repo.mkdir()
        git(repo, "init", "-q")
        git(repo, "config", "user.name", "Snapshot Test")
        git(repo, "config", "user.email", "snapshot@example.invalid")
        git(repo, "config", "commit.gpgsign", "false")
        git(repo, "config", "core.hooksPath", "/dev/null")
        suite = repo / "spec/formal/spiffe-peer-domain"
        suite.mkdir(parents=True)
        (suite / "coverage.json").write_text(json.dumps({
            "sources": [{"path": "covered.txt"}],
            "optional_sources": [{"path": "ignored-config.txt"}],
        }))
        (repo / ".gitignore").write_text("ignored-config.txt\n")
        for name in ("covered.txt", "deleted.txt", "rename-old.txt"):
            (repo / name).write_text("base\n")
        git(repo, "add", ".")
        git(repo, "commit", "-qm", "base")
        (repo / "covered.txt").write_text("changed\n")
        (repo / "deleted.txt").unlink()
        (repo / "rename-old.txt").rename(repo / "rename-new.txt")
        (repo / "odd name.txt").write_text("untracked\n")
        (repo / "ignored-config.txt").write_text("covered configuration\n")
        module["ROOT"] = repo
        target = base / "snapshot"
        target.mkdir()
        module["archive"](target)
        assert (target / "covered.txt").read_text() == "changed\n"
        assert not (target / "deleted.txt").exists()
        assert not (target / "rename-old.txt").exists()
        assert (target / "rename-new.txt").read_text() == "base\n"
        assert (target / "odd name.txt").read_text() == "untracked\n"
        assert (target / "ignored-config.txt").read_text() == "covered configuration\n"
        coverage = suite / "coverage.json"
        original = coverage.read_text()
        (repo / "alias").symlink_to(base, target_is_directory=True)
        for index, unsafe in enumerate(("../outside", "alias/escape")):
            coverage.write_text(json.dumps({
                "sources": [{"path": unsafe}], "optional_sources": []
            }))
            rejected = base / f"unsafe-{index}"
            rejected.mkdir()
            try:
                module["archive"](rejected)
            except RuntimeError as error:
                assert "scratch" in str(error)
            else:
                raise AssertionError(f"unsafe path accepted: {unsafe}")
        coverage.write_text(original)
        (repo / "alias").unlink()
        for name in ("covered.txt", "deleted.txt", "odd name.txt"):
            git(repo, "reset", "-q")
            git(repo, "add", "--", name)
            try:
                module["archive"](base / "staged")
            except RuntimeError as error:
                assert "empty index" in str(error)
            else:
                raise AssertionError(f"a staged change was silently omitted: {name}")
    print("peer scratch snapshot: modifications, deletions, renames, unsafe paths and staged-index guard passed")


if __name__ == "__main__":
    main()
