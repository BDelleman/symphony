#!/usr/bin/env python3
"""Copy explicitly included, Git-ignored files into an agent worktree.

Default behavior is intentionally small:
- source defaults to the current repository
- policy comes from <source>/.worktreeinclude
- only Git-ignored/untracked files are eligible
- credential and authentication material is always hard-denied
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Sequence

SKIP_ROOTS = {
    ".git",
    ".hg",
    ".jj",
    ".svn",
    ".worktrees",
    ".symphony",
    ".conductor",
    "node_modules",
}
SENSITIVE_NAMES = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnpmrc",
    ".pypirc",
    ".netrc",
    ".authinfo",
    ".git-credentials",
    ".claude.json",
    ".mcp.json",
    "credentials",
    "credentials.json",
    "*service-account*.json",
    "known_hosts",
)
SENSITIVE_DIRECTORIES = {
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".gnupg",
    ".docker",
    ".terraform.d",
    ".cargo",
    ".composer",
}


@dataclass(frozen=True)
class Rule:
    pattern: str
    negated: bool = False
    anchored: bool = False
    directory: bool = False


@dataclass(frozen=True)
class Candidate:
    rel: str
    is_dir: bool


def log(action: str, reason: str, **fields: object) -> None:
    print(json.dumps({"action": action, "reason": reason, **fields}, sort_keys=True))


def fail(reason: str) -> None:
    log("error", reason)
    raise SystemExit(2)


def git(repo: Path, *args: str) -> bytes:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        fail("git not found on PATH")

    if proc.returncode:
        stderr = proc.stderr.decode(errors="replace").strip()
        fail(f"git {' '.join(args)} failed: {stderr}")
    return proc.stdout


def repo_root(path: Path) -> Path:
    path = path.expanduser().resolve()
    root = git(path, "rev-parse", "--show-toplevel").decode().strip()
    return Path(root).resolve()


def git_common_dir(repo: Path) -> Path:
    raw = git(repo, "rev-parse", "--git-common-dir").decode().strip()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = (repo / candidate).resolve()
    return candidate.resolve()


def resolve_auto_source_root(target_repo_root: Path) -> Path:
    common_dir = git_common_dir(target_repo_root)
    try:
        proc = subprocess.run(
            ["git", "--git-dir", str(common_dir), "worktree", "list", "--porcelain"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        fail("git not found on PATH")

    if proc.returncode != 0:
        stderr = proc.stderr.decode(errors="replace").strip()
        fail(f"git worktree list failed: {stderr}")

    target_str = str(target_repo_root)
    for raw in proc.stdout.decode(errors="replace").splitlines():
        if not raw.startswith("worktree "):
            continue
        candidate = Path(raw[len("worktree ") :].strip()).resolve()
        if str(candidate) != target_str:
            return candidate

    fail("unable to resolve source worktree root")


def rel_posix(path: str) -> str:
    p = PurePosixPath(path.replace(os.sep, "/"))
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts):
        fail(f"unsafe relative path: {path!r}")
    return p.as_posix()


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root)
        return True
    except ValueError:
        return False


def parse_worktreeinclude(path: Path) -> list[Rule]:
    if not path.exists():
        return []

    rules: list[Rule] = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        negated = line.startswith("!")
        if negated:
            line = line[1:].strip()

        anchored = line.startswith("/")
        if anchored:
            line = line[1:]

        directory = line.endswith("/")
        if directory:
            line = line[:-1]

        if not line:
            fail(f"invalid .worktreeinclude pattern on line {number}")

        rules.append(
            Rule(
                pattern=rel_posix(line),
                negated=negated,
                anchored=anchored,
                directory=directory,
            )
        )

    return rules


def rule_matches(rule: Rule, rel: str, is_dir: bool) -> bool:
    if rule.directory and not (
        is_dir or rel.startswith(rule.pattern.rstrip("/") + "/")
    ):
        return False

    if rule.anchored or "/" in rule.pattern:
        return (
            rel == rule.pattern
            or fnmatch.fnmatchcase(rel, rule.pattern)
            or rel.startswith(rule.pattern.rstrip("/") + "/")
        )

    return any(fnmatch.fnmatchcase(part, rule.pattern) for part in rel.split("/"))


def included(rules: Sequence[Rule], candidate: Candidate) -> bool:
    keep = False
    for rule in rules:
        if rule_matches(rule, candidate.rel, candidate.is_dir):
            keep = not rule.negated
    return keep


def ignored_untracked(source: Path) -> list[Candidate]:
    out = git(
        source,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
    )
    candidates: list[Candidate] = []

    for raw in out.split(b"\0"):
        if not raw:
            continue
        rel = rel_posix(raw.decode(errors="surrogateescape").rstrip("/"))
        if rel.split("/", 1)[0] in SKIP_ROOTS:
            log("skip", "excluded workspace/tool directory", path=rel)
            continue
        candidates.append(Candidate(rel=rel, is_dir=(source / rel).is_dir()))

    return sorted(candidates, key=lambda c: c.rel)


def expand_files(source: Path, candidates: Iterable[Candidate]) -> list[Candidate]:
    files: list[Candidate] = []
    for candidate in candidates:
        path = source / candidate.rel
        if not candidate.is_dir or path.is_symlink():
            files.append(Candidate(candidate.rel, is_dir=False))
            continue

        for child in sorted(path.rglob("*")):
            if child.is_dir() and not child.is_symlink():
                continue
            files.append(Candidate(child.relative_to(source).as_posix(), is_dir=False))
    return files


def sensitive(rel: str) -> bool:
    parts = tuple(part.lower() for part in PurePosixPath(rel).parts)
    name = parts[-1]
    if any(fnmatch.fnmatchcase(name, pat) for pat in SENSITIVE_NAMES):
        return True
    if any(part in SENSITIVE_DIRECTORIES for part in parts):
        return True
    return any(
        parts[index : index + 2] in (
            (".config", "gh"),
            (".config", "gcloud"),
            (".config", "containers"),
            (".config", "pip"),
            (".config", "pypoetry"),
        )
        for index in range(max(0, len(parts) - 1))
    )


def validate_copy(source: Path, target: Path, rel: str) -> tuple[Path, Path]:
    src = source / rel
    dst = target / rel

    if not src.exists() and not src.is_symlink():
        fail(f"source disappeared while copying: {rel}")
    if not inside(src, source):
        fail(f"source escapes repository: {rel}")
    if not inside(dst.parent, target):
        fail(f"destination escapes target: {rel}")

    if src.is_symlink():
        fail(f"refusing to copy symlink: {rel}")

    return src, dst


def copy_one(
    source: Path, target: Path, rel: str, *, dry_run: bool, force: bool
) -> str:
    src, dst = validate_copy(source, target, rel)

    if dst.exists() or dst.is_symlink():
        if not force:
            log("skip", "destination exists; pass --force to overwrite", path=rel)
            return "skipped"
        if not dry_run:
            (
                shutil.rmtree(dst)
                if dst.is_dir() and not dst.is_symlink()
                else dst.unlink()
            )

    if dry_run:
        log("copy", "dry-run", path=rel, sensitive=sensitive(rel))
        return "copied"

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst, follow_symlinks=False)
    log("copy", "copied", path=rel, sensitive=sensitive(rel))
    return "copied"


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bootstrap an agent worktree with explicitly included ignored files."
    )
    parser.add_argument(
        "--source",
        type=str,
        default="auto",
        help="source repo/worktree path or 'auto' to select a sibling worktree (default: auto)",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=Path.cwd(),
        help="target repo/worktree, default: current directory",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="show what would be copied"
    )
    parser.add_argument(
        "--force", action="store_true", help="overwrite existing target files"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] = sys.argv[1:]) -> int:
    args = parse_args(argv)
    target = repo_root(args.target)
    if args.source.strip().lower() == "auto":
        # A standalone clone has no sibling entry in `git worktree list`. Its
        # tracked include policy is nevertheless enough to prove a no-op, so
        # avoid failing clone-provisioned workspaces when no artifacts are
        # requested.
        target_include_file = target / ".worktreeinclude"
        target_rules = parse_worktreeinclude(target_include_file)
        if not target_include_file.exists():
            log("summary", "include file missing; copied nothing", copied=0, skipped="all")
            return 0
        if not target_rules:
            log("summary", "include file has no active patterns; copied nothing", copied=0)
            return 0
    source = (
        resolve_auto_source_root(target)
        if args.source.strip().lower() == "auto"
        else repo_root(Path(args.source))
    )
    include_file = source / ".worktreeinclude"

    if source == target:
        fail("source and target resolve to the same repository")

    rules = parse_worktreeinclude(include_file)
    if not include_file.exists():
        log("summary", "include file missing; copied nothing", copied=0, skipped="all")
        return 0
    if not rules:
        log("summary", "include file has no active patterns; copied nothing", copied=0)
        return 0

    log(
        "summary",
        "starting worktree bootstrap",
        source=str(source),
        target=str(target),
        include=str(include_file),
        dry_run=args.dry_run,
    )

    candidates = expand_files(source, ignored_untracked(source))
    selected = [candidate.rel for candidate in candidates if included(rules, candidate)]

    copied = skipped_sensitive = 0
    for rel in selected:
        is_sensitive = sensitive(rel)
        if is_sensitive:
            log(
                "skip",
                "sensitive path is hard-denied",
                path=rel,
                sensitive=True,
            )
            skipped_sensitive += 1
            continue

        result = copy_one(source, target, rel, dry_run=args.dry_run, force=args.force)
        if result == "copied":
            copied += 1

    summary_reason = (
        "finished_with_sensitive_skips" if skipped_sensitive > 0 else "finished_worktree_bootstrap"
    )
    log(
        "summary",
        summary_reason,
        selected=len(selected),
        copied=copied,
        skipped_sensitive=skipped_sensitive,
        dry_run=args.dry_run,
    )
    # Sensitive skips are treated as benign/idempotent outcomes for unattended hooks.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
