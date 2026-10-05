#!/usr/bin/env python3
"""Bundle checks for the buildgate-bundle skill.

  bundle_check.py freeze --repo <worktree> <test files...>
      write <worktree>/.bundle/frozen-tests.sha256

  bundle_check.py verify-run --bundle <plans>/<feature> --ticket NNN --base SHA --result SHA [--extra CMD]
      independent check of an accepted build: diff inside Allowed-Files, the
      ticket's tests differ from base only by the deleted gate line, verify
      (and --extra, e.g. the full-suite command) pass in a clean checkout.

  bundle_check.py check --bundle <plans>/<feature> [--skip-runs]
      static checks + verify runs (bundle commit passes, each ticket's tests
      fail on the stubs, each reference commit passes). Exit 0 = bundle ready.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SPEC_HEADINGS = ["# Spec", "## Problem", "## Scope", "## Non-goals",
                 "## Affected services and packages", "## Acceptance criteria",
                 "## Risks", "## Open questions"]
GATE_RE = re.compile(r'^(//go:build bundle_t\d+|raise unittest\.SkipTest\("bundle: .*|'
                     r'pytest\.skip\("bundle: .*)$')
MAX_CHANGED_LINES = 150
FACTORYD = shutil.which("factoryd") or os.path.expanduser("~/go/bin/factoryd")

failures = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL  {msg}")


def ok(msg):
    print(f"ok    {msg}")


def gate_line(path, ticket):
    if path.endswith(".go"):
        return f"//go:build bundle_t{ticket}"
    return f'raise unittest.SkipTest("bundle: enabled by ticket {ticket}")'


def frozen_hash(text):
    kept = [l for l in text.split("\n") if l.strip() and not GATE_RE.match(l)]
    return hashlib.sha256(("\n".join(kept) + "\n").encode()).hexdigest()


def cmd_freeze(args):
    repo = Path(args.repo)
    out = repo / ".bundle" / "frozen-tests.sha256"
    out.parent.mkdir(exist_ok=True)
    lines = [f"{frozen_hash((repo / t).read_text())}  {t}" for t in args.tests]
    out.write_text("\n".join(lines) + "\n")
    print(f"wrote {out} ({len(lines)} files)")
    # Cross-check against the shell implementation the sandbox runs.
    r = subprocess.run(["sh", ".bundle/check-frozen.sh"], cwd=repo, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        sys.exit("check-frozen.sh disagrees with the manifest just written")


def parse_ticket(path):
    text = Path(path).read_text()
    headers, body_started = {}, False
    for line in text.split("\n"):
        if line.startswith("## "):
            body_started = True
        m = re.match(r"^([A-Za-z-]+):\s*(.*)$", line)
        if m and not body_started:
            headers.setdefault(m.group(1), []).append(m.group(2).strip())
    covered = []
    m = re.search(r"### Acceptance criteria covered\n(.*?)(\n## |\Z)", text, re.S)
    if m:
        covered = [int(x) for x in re.findall(r"^- (\d+)\s*$", m.group(1), re.M)]
    split = lambda key: [p.strip() for v in headers.get(key, []) for p in v.split(",") if p.strip()]
    return {"text": text, "verify": (headers.get("Verify-Command") or [""])[0],
            "allowed": split("Allowed-Files"), "required": split("Required-Changed-Files"),
            "content": headers.get("Required-Content", []),
            "covered": covered}


def spec_criteria(spec_text):
    m = re.search(r"## Acceptance criteria\n(.*?)\n## ", spec_text, re.S)
    return [int(x) for x in re.findall(r"^(\d+)\.\s", m.group(1), re.M)] if m else []


def allowed(path, patterns):
    return any(path == p or fnmatch.fnmatch(path, p) for p in patterns)


def git(repo, *a, check=True):
    return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, check=check).stdout


def run_verify(wt, cmd, label, expect_pass):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run(["sh", "-c", cmd], cwd=wt, capture_output=True, text=True, env=env, timeout=1800)
    passed = r.returncode == 0
    if passed == expect_pass:
        ok(f"{label}: verify {'passes' if passed else 'fails'} as expected")
    else:
        tail = "\n".join((r.stdout + r.stderr).strip().split("\n")[-25:])
        fail(f"{label}: verify {'passed' if passed else 'failed'}, expected the opposite\n{tail}")
    git(wt, "checkout", "--", ".", check=False)
    git(wt, "clean", "-fdq", check=False)


def cmd_check(args):
    bdir = Path(args.bundle)
    cfg = json.loads((bdir / "bundle.json").read_text())
    cfg["repo"], cfg["worktree"] = os.path.expanduser(cfg["repo"]), os.path.expanduser(cfg["worktree"])
    wt, verify = Path(cfg["worktree"]), cfg["verify_command"]
    spec = (bdir / "spec.md").read_text()

    # 1. spec skeleton
    heads = [l.rstrip() for l in spec.split("\n") if l.startswith("#")]
    if [h for h in heads if h in SPEC_HEADINGS] == SPEC_HEADINGS:
        ok("spec skeleton headings in order")
    else:
        fail(f"spec headings {heads} != skeleton {SPEC_HEADINGS}")
    criteria = spec_criteria(spec)
    if criteria != list(range(1, len(criteria) + 1)) or not criteria:
        fail(f"acceptance criteria must be numbered 1..N, got {criteria}")

    # 2. tickets
    tickets = {}
    for p in sorted((bdir / "tickets").glob("*.spec.md")):
        num = p.name.split(".")[0]
        t = tickets[num] = parse_ticket(p)
        r = subprocess.run([FACTORYD, "check-ticket", str(p)], capture_output=True, text=True)
        (ok if r.returncode == 0 else fail)(f"{num}: factoryd check-ticket" +
                                             ("" if r.returncode == 0 else "\n" + r.stdout + r.stderr))
        if t["verify"] != verify:
            fail(f"{num}: Verify-Command differs from bundle verify_command")
        for h in ["## Goal", "## Plan", "### Files to touch", "### Steps", "### Tests to add",
                  "### Acceptance criteria covered", "## Out of scope"]:
            if not re.search(rf"^{re.escape(h)}\s*$", t["text"], re.M):
                fail(f"{num}: missing heading {h}")
        tests = cfg["tests"].get(num, [])
        if not tests:
            fail(f"{num}: no test files listed in bundle.json")
        for tf in tests:
            if not (allowed(tf, t["allowed"]) and tf in t["required"]):
                fail(f"{num}: {tf} must be in Allowed-Files and Required-Changed-Files")
            content = (wt / tf).read_text() if (wt / tf).exists() else ""
            g = gate_line(tf, num)
            if content.split("\n").count(g) != 1:
                fail(f"{num}: {tf} must contain the gate line `{g}` exactly once")
            if g not in t["text"]:
                fail(f"{num}: ticket text must tell the executor to delete `{g}`")
        for r_ in t["required"]:
            if not allowed(r_, t["allowed"]):
                fail(f"{num}: Required-Changed-File {r_} not in Allowed-Files")
    if not tickets:
        fail("no tickets")

    # 3. coverage
    cov_rows = re.findall(r"^\|\s*(\d+)\s*\|\s*(\d{3})\s*\|\s*([^|]+)\|", (bdir / "coverage.md").read_text(), re.M)
    cov = {}
    for c, num, names in cov_rows:
        cov.setdefault(int(c), []).append((num, [n.strip(" `") for n in names.split(",") if n.strip()]))
    for c in criteria:
        by_ticket = [n for n, t in tickets.items() if c in t["covered"]]
        if not by_ticket:
            fail(f"criterion {c}: no ticket covers it")
        if c not in cov:
            fail(f"criterion {c}: missing from coverage.md")
            continue
        for num, names in cov[c]:
            if num not in by_ticket:
                fail(f"criterion {c}: coverage.md names ticket {num}, which does not list it")
            src = "".join((wt / tf).read_text() for tf in cfg["tests"].get(num, []) if (wt / tf).exists())
            for n in names:
                if not re.search(rf"(func {re.escape(n)}\(|def {re.escape(n)}\(|\"{re.escape(n)}\")", src):
                    fail(f"criterion {c}: test {n} not found in ticket {num}'s test files")
    for n, t in tickets.items():
        extra = [c for c in t["covered"] if c not in criteria]
        if extra:
            fail(f"{n}: covers unknown criteria {extra}")
    if not failures:
        ok(f"coverage: {len(criteria)} criteria -> tickets -> tests")

    if args.skip_runs:
        return finish()

    # 4-6. verify runs in a scratch worktree
    base = git(cfg["repo"], "rev-parse", cfg["branch"]).strip()
    refs = git(cfg["repo"], "rev-list", "--reverse", f"{base}..{cfg['ref_branch']}").split()
    tmp = Path(tempfile.mkdtemp(prefix="bundle-check-"))
    scratch = tmp / "wt"
    git(cfg["repo"], "worktree", "add", "--detach", str(scratch), base)
    try:
        run_verify(scratch, verify, "bundle commit (stubs, tests dormant)", True)
        for num in tickets:
            for tf in cfg["tests"][num]:
                p = scratch / tf
                g = gate_line(tf, num)
                p.write_text("\n".join(l for l in p.read_text().split("\n") if l != g))
            run_verify(scratch, verify, f"{num}: its tests enabled on stubs", False)
        if len(refs) != len(tickets):
            fail(f"ref branch has {len(refs)} commits, want one per ticket ({len(tickets)})")
        for num, sha in zip(tickets, refs):
            changed = git(cfg["repo"], "diff", "--name-only", f"{sha}^", sha).split()
            outside = [f for f in changed if not allowed(f, tickets[num]["allowed"])]
            if outside:
                fail(f"{num}: reference commit touches files outside Allowed-Files: {outside}")
            lines = 0
            for row in git(cfg["repo"], "diff", "--numstat", f"{sha}^", sha).strip().split("\n"):
                if row and row.split("\t")[2] not in cfg["tests"][num]:
                    lines += int(row.split("\t")[0]) + int(row.split("\t")[1])
            (ok if lines <= MAX_CHANGED_LINES else fail)(f"{num}: reference changes {lines} non-test lines (<= {MAX_CHANGED_LINES})")
            for lit in tickets[num]["content"]:
                hit = [f for f in tickets[num]["required"]
                       if lit in git(cfg["repo"], "show", f"{sha}:{f}", check=False)
                       and lit not in git(cfg["repo"], "show", f"{sha}^:{f}", check=False)]
                (ok if hit else fail)(f"{num}: Required-Content `{lit}` added by the reference" +
                                      (f" in {hit[0]}" if hit else " in no Required-Changed-File (it must be absent before the ticket)"))
            git(scratch, "checkout", "--detach", "-q", sha)
            run_verify(scratch, verify, f"{num}: reference commit {sha[:8]}", True)
    finally:
        git(cfg["repo"], "worktree", "remove", "--force", str(scratch), check=False)
        shutil.rmtree(tmp, ignore_errors=True)
    return finish()


def cmd_verify_run(args):
    bdir = Path(args.bundle)
    cfg = json.loads((bdir / "bundle.json").read_text())
    repo = os.path.expanduser(cfg["repo"])
    t = parse_ticket(bdir / "tickets" / f"{args.ticket}.spec.md")
    rng = f"{args.base}..{args.result}"
    changed = git(repo, "diff", "--name-only", args.base, args.result).split()
    outside = [f for f in changed if not allowed(f, t["allowed"])]
    (fail if outside else ok)(f"diff inside Allowed-Files ({len(changed)} files)" + (f": outside {outside}" if outside else ""))
    for f in t["required"]:
        if f not in changed:
            fail(f"Required-Changed-File {f} unchanged")
    for tf in cfg["tests"][args.ticket]:
        diff = git(repo, "diff", "-U0", args.base, args.result, "--", tf)
        body = [l for l in diff.split("\n") if l and l[0] in "+-" and not l.startswith(("+++", "---"))]
        bad = [l for l in body if not (l.startswith("-") and (GATE_RE.match(l[1:]) or not l[1:].strip()))]
        (fail if bad else ok)(f"{tf}: only the gate line removed" + (f"; other changes: {bad[:5]}" if bad else ""))
    print(f"commits {rng}: " + " | ".join(git(repo, "log", "--format=%h %s", rng).strip().split("\n")))
    tmp = Path(tempfile.mkdtemp(prefix="verify-run-"))
    scratch = tmp / "wt"
    git(repo, "worktree", "add", "--detach", str(scratch), args.result)
    try:
        run_verify(scratch, cfg["verify_command"], f"{args.ticket}: verify at {args.result[:8]}", True)
        if args.extra:
            run_verify(scratch, args.extra, f"{args.ticket}: extra `{args.extra}`", True)
    finally:
        git(repo, "worktree", "remove", "--force", str(scratch), check=False)
        shutil.rmtree(tmp, ignore_errors=True)
    finish("RUN VERIFIED")


def finish(label="BUNDLE READY"):
    print(f"\n{label if not failures else f'{len(failures)} FAILURE(S)'}")
    sys.exit(0 if not failures else 1)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("freeze")
    f.add_argument("--repo", required=True)
    f.add_argument("tests", nargs="+")
    c = sub.add_parser("check")
    c.add_argument("--bundle", required=True)
    c.add_argument("--skip-runs", action="store_true")
    v = sub.add_parser("verify-run")
    v.add_argument("--bundle", required=True)
    v.add_argument("--ticket", required=True)
    v.add_argument("--base", required=True)
    v.add_argument("--result", required=True)
    v.add_argument("--extra", default="")
    a = ap.parse_args()
    {"freeze": cmd_freeze, "check": cmd_check, "verify-run": cmd_verify_run}[a.cmd](a)


if __name__ == "__main__":
    main()
