#!/usr/bin/env python3
"""test_deploy_dist.py — stdlib suite for ops/hub/deploy-dist.sh (amicode #1906, A13b).

Runs the REAL script against a TEMP service dir and a temp git worktree whose
`origin` is a temp bare repo; the build step is injected via
DEPLOY_DIST_BUILD_CMD (a fake that stamps deploy.json the way
build_app_bundle.mjs does). No production path is touched — safe on the live hub.

Linux only (the flip uses GNU `mv -T`; the first-run migration uses
renameat2(RENAME_EXCHANGE)). On macOS the suite skips with the reason printed;
run it on the hub from a /tmp scratch copy:
    rsync -a ops/hub/ amico-hub:/tmp/deploy-dist-test/
    ssh amico-hub 'python3 /tmp/deploy-dist-test/test_deploy_dist.py'

Run: python3 ops/hub/test_deploy_dist.py   (exit 0 on pass)
Set AMICODE_TEST_KEEPDIR=1 to keep temp dirs for debugging.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "deploy-dist.sh")
KEEP = bool(os.environ.get("AMICODE_TEST_KEEPDIR"))
LANE = "lane/0.3.10"

# The fake build: what build_app_bundle.mjs produces, minus the bun build —
# packages/extension/dist/app/{index.html, assets/index-<hash>.js, deploy.json}.
# FAKE_BUILD_DIRTY_STAMP=1 stamps dirty:true (a tree that dirtied mid-build);
# FAKE_BUILD_NOOP=1 builds nothing (a silently no-op'd build).
FAKE_BUILD = r"""#!/usr/bin/env bash
set -euo pipefail
[ "${FAKE_BUILD_NOOP:-}" = 1 ] && exit 0
head="$(git rev-parse HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
dirty=false
[ -n "$(git status --porcelain)" ] && dirty=true
[ "${FAKE_BUILD_DIRTY_STAMP:-}" = 1 ] && dirty=true
h="$(date +%s%N | sha256sum | cut -c1-8)"
mkdir -p dist/app/assets
printf 'console.log("%s")\n' "$h" > "dist/app/assets/index-$h.js"
printf '<!doctype html><script type="module" crossorigin src="/assets/index-%s.js"></script>\n' "$h" > dist/app/index.html
if [ -n "${AMICODE_DEPLOY_OVERRIDE:-}" ]; then ov="\"$AMICODE_DEPLOY_OVERRIDE\""; else ov=null; fi
printf '{"commit":"%s","branch":"%s","dirty":%s,"override_reason":%s,"built_at":"%s","deployed_by":"fake@test"}\n' \
  "$head" "$branch" "$dirty" "$ov" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > dist/app/deploy.json
printf '%s\n' "${AMICODE_DEPLOY_BASELINE:-<unset>}" > "$FAKE_BUILD_ENV_LOG"
"""

# A reader loop: `test -e` on the served path as fast as bash goes, until the
# stop file appears; prints "<iterations> <misses>".
READER = r"""#!/usr/bin/env bash
p="$1"; stop="$2"; ready="$3"; n=0; miss=0
: > "$ready"
while [ ! -e "$stop" ]; do
  n=$((n + 1))
  test -e "$p" || miss=$((miss + 1))
done
echo "$n $miss"
"""


def git(cwd, *args, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(sys.platform.startswith("linux"), "deploy-dist.sh targets Linux (GNU mv -T, renameat2) — run on the hub")
class DeployDistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="deploy-dist-test-")
        self.origin = os.path.join(self.tmp, "origin.git")
        self.wt = os.path.join(self.tmp, "wt")
        self.svc = os.path.join(self.tmp, "service")
        self.envlog = os.path.join(self.tmp, "build-env.log")
        subprocess.run(["git", "init", "-q", "--bare", self.origin], check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", self.wt], check=True)
        git(self.wt, "config", "user.email", "t@t")
        git(self.wt, "config", "user.name", "t")
        os.makedirs(os.path.join(self.wt, "packages", "extension"))
        with open(os.path.join(self.wt, ".gitignore"), "w") as f:
            f.write("dist/\n")
        with open(os.path.join(self.wt, "packages", "extension", "README"), "w") as f:
            f.write("ext\n")
        git(self.wt, "add", "-A")
        git(self.wt, "commit", "-qm", "init")
        git(self.wt, "remote", "add", "origin", self.origin)
        git(self.wt, "push", "-q", "origin", "main")
        git(self.wt, "checkout", "-qb", LANE)
        git(self.wt, "push", "-q", "-u", "origin", LANE)
        self.build = os.path.join(self.tmp, "fake-build.sh")
        with open(self.build, "w") as f:
            f.write(FAKE_BUILD)
        os.chmod(self.build, 0o755)
        self.reader = os.path.join(self.tmp, "reader.sh")
        with open(self.reader, "w") as f:
            f.write(READER)
        os.chmod(self.reader, 0o755)
        # the legacy service: dist-app is a REAL directory (today's hub)
        legacy = os.path.join(self.svc, "dist-app")
        os.makedirs(os.path.join(legacy, "assets"))
        with open(os.path.join(legacy, "index.html"), "w") as f:
            f.write('<script type="module" src="/assets/index-legacy00.js"></script>\n')
        with open(os.path.join(legacy, "assets", "index-legacy00.js"), "w") as f:
            f.write("legacy\n")
        with open(os.path.join(legacy, "deploy.json"), "w") as f:
            json.dump({"commit": "abcdef0123456789", "branch": "lane/0.3.9", "dirty": True,
                       "override_reason": "hand swap", "built_at": "2026-10-25T18:25:00.000Z"}, f)

    def tearDown(self):
        if KEEP:
            print(f"kept {self.tmp}")
        else:
            shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers ---------------------------------------------------------------
    def run_script(self, *args, env=None, check_ok=None):
        e = dict(os.environ)
        e.pop("AMICODE_DEPLOY_OVERRIDE", None)
        e.update({"DEPLOY_DIST_BUILD_CMD": self.build, "FAKE_BUILD_ENV_LOG": self.envlog,
                  "DEPLOY_DIST_OPERATOR": "tester@hub"})
        e.update(env or {})
        r = subprocess.run(["bash", SCRIPT, "--worktree", self.wt, "--service-dir", self.svc, *args],
                           capture_output=True, text=True, env=e)
        out = r.stdout + r.stderr
        if check_ok is True:
            self.assertEqual(r.returncode, 0, out)
        elif check_ok is False:
            self.assertNotEqual(r.returncode, 0, out)
        return r.returncode, out

    def lane_commit(self, msg="c", push=True):
        with open(os.path.join(self.wt, "f.txt"), "a") as f:
            f.write(msg + "\n")
        git(self.wt, "add", "-A")
        git(self.wt, "commit", "-qm", msg)
        if push:
            git(self.wt, "push", "-q", "origin", LANE)
        return git(self.wt, "rev-parse", "HEAD")

    def link(self):
        return os.path.join(self.svc, "dist-app")

    def target(self):
        return os.path.basename(os.readlink(self.link()))

    def releases(self):
        d = os.path.join(self.svc, "dist-releases")
        return sorted(n for n in os.listdir(d) if not n.startswith(".")) if os.path.isdir(d) else []

    def records(self):
        p = os.path.join(self.svc, "dist-deploys.jsonl")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return [json.loads(l) for l in f if l.strip()]

    def served_index(self):
        with open(os.path.join(self.link(), "index.html")) as f:
            return f.read()

    def start_reader(self, path):
        stop = os.path.join(self.tmp, "reader.stop")
        ready = os.path.join(self.tmp, "reader.ready")
        for p in (stop, ready):
            if os.path.exists(p):
                os.remove(p)
        proc = subprocess.Popen(["bash", self.reader, path, stop, ready], stdout=subprocess.PIPE, text=True)
        while not os.path.exists(ready):
            time.sleep(0.01)
        time.sleep(0.05)
        return proc, stop

    def stop_reader(self, proc, stop):
        time.sleep(0.05)
        open(stop, "w").close()
        out, _ = proc.communicate(timeout=30)
        n, miss = (int(x) for x in out.split())
        return n, miss

    # --- the refusals -----------------------------------------------------------
    def test_dirty_worktree_refused_and_nothing_changes(self):
        with open(os.path.join(self.wt, "f.txt"), "w") as f:
            f.write("uncommitted\n")
        _, out = self.run_script(check_ok=False)
        self.assertIn("dirty", out)
        self.assertTrue(os.path.isdir(self.link()) and not os.path.islink(self.link()), "dist-app untouched")
        self.assertEqual(self.releases(), [])
        self.assertEqual(self.records(), [])
        self.assertFalse(os.path.exists(self.envlog), "the build never ran")

    def test_dirty_worktree_with_override_deploys_and_records_reason(self):
        with open(os.path.join(self.wt, "f.txt"), "w") as f:
            f.write("uncommitted\n")
        self.run_script("--override", "hotfix #1906 test", check_ok=True)
        rec = self.records()[-1]
        self.assertEqual(rec["override_reason"], "hotfix #1906 test")
        self.assertTrue(rec["dirty"])
        with open(os.path.join(self.link(), "deploy.json")) as f:
            self.assertEqual(json.load(f)["override_reason"], "hotfix #1906 test")

    def test_blank_override_refused(self):
        self.run_script("--override", "  ", check_ok=False)

    def test_head_not_a_lane_tip_refused(self):
        self.lane_commit("local only", push=False)
        _, out = self.run_script(check_ok=False)
        self.assertIn("tip", out)
        self.assertEqual(self.releases(), [])

    def test_feature_branch_tip_refused(self):
        git(self.wt, "checkout", "-qb", "feature/x")
        self.lane_commit("feat", push=False)
        git(self.wt, "push", "-q", "origin", "feature/x")
        self.run_script(check_ok=False)

    def test_build_stamped_dirty_refused(self):
        _, out = self.run_script(env={"FAKE_BUILD_DIRTY_STAMP": "1"}, check_ok=False)
        self.assertIn("dirty", out)
        self.assertTrue(os.path.isdir(self.link()) and not os.path.islink(self.link()))
        self.assertEqual(self.records(), [])

    def test_noop_build_refused(self):
        _, out = self.run_script(env={"FAKE_BUILD_NOOP": "1"}, check_ok=False)
        self.assertIn("index.html", out)

    def test_dry_run_changes_nothing(self):
        _, out = self.run_script("--dry-run", check_ok=True)
        self.assertIn("DRY-RUN", out)
        self.assertTrue(os.path.isdir(self.link()) and not os.path.islink(self.link()))
        self.assertEqual(self.releases(), [])
        self.assertEqual(self.records(), [])
        self.assertFalse(os.path.exists(self.envlog))

    # --- deploy, migration, atomicity, provenance -----------------------------
    def test_first_run_migration_is_gapless_and_keeps_legacy_as_previous(self):
        head = git(self.wt, "rev-parse", "HEAD")
        proc, stop = self.start_reader(os.path.join(self.link(), "index.html"))
        try:
            self.run_script(check_ok=True)
        finally:
            n, miss = self.stop_reader(proc, stop)
        self.assertGreater(n, 100, "the reader loop actually ran")
        self.assertEqual(miss, 0, f"the served path went missing {miss}/{n} times during the migration")
        self.assertTrue(os.path.islink(self.link()))
        self.assertEqual(os.readlink(self.link()), f"dist-releases/{self.target()}", "relative symlink")
        self.assertTrue(self.target().endswith(head[:8]))
        rels = self.releases()
        self.assertEqual(len(rels), 2, rels)
        legacy = [r for r in rels if r.endswith("-migrated")]
        self.assertEqual(len(legacy), 1, rels)
        self.assertIn("abcdef01", legacy[0])
        self.assertTrue(os.path.exists(os.path.join(self.svc, "dist-releases", legacy[0], "assets", "index-legacy00.js")))
        self.assertEqual(os.path.basename(os.readlink(os.path.join(self.svc, "dist-releases.previous"))), legacy[0])
        self.assertNotIn("legacy00", self.served_index())
        with open(self.envlog) as f:
            self.assertEqual(f.read().strip(), LANE, "the build guard was pinned to the lane baseline")

    def test_symlink_flip_is_atomic_under_a_reader_loop(self):
        self.run_script(check_ok=True)
        self.lane_commit("second")
        self.run_script(check_ok=True)
        proc, stop = self.start_reader(os.path.join(self.link(), "index.html"))
        try:
            for _ in range(15):
                self.run_script("--rollback", check_ok=True)
            self.lane_commit("third")
            self.run_script(check_ok=True)
        finally:
            n, miss = self.stop_reader(proc, stop)
        self.assertGreater(n, 1000)
        self.assertEqual(miss, 0, f"the served path went missing {miss}/{n} times during 16 flips")

    def test_provenance_record_fields(self):
        head = git(self.wt, "rev-parse", "HEAD")
        self.run_script(check_ok=True)
        recs = self.records()
        self.assertEqual(len(recs), 1)
        r = recs[0]
        for k in ("ts", "built_at", "action", "lane_branch", "head_sha", "bundle", "release_dir",
                  "override_reason", "operator", "dirty", "previous_release"):
            self.assertIn(k, r)
        self.assertEqual(r["action"], "deploy")
        self.assertEqual(r["lane_branch"], LANE)
        self.assertEqual(r["head_sha"], head)
        self.assertIsNone(r["override_reason"])
        self.assertFalse(r["dirty"])
        self.assertEqual(r["operator"], "tester@hub")
        self.assertEqual(r["release_dir"], os.path.join(os.path.realpath(self.svc), "dist-releases", self.target()))
        self.assertRegex(r["bundle"]["name"], r"^index-[0-9a-f]{8}\.js$")
        self.assertIn(r["bundle"]["name"], self.served_index())
        js = os.path.join(r["release_dir"], "assets", r["bundle"]["name"])
        sha = subprocess.run(["sha256sum", js], capture_output=True, text=True).stdout.split()[0]
        self.assertEqual(r["bundle"]["sha256"], sha)
        # the release keeps build_app_bundle's deploy.json
        with open(os.path.join(r["release_dir"], "deploy.json")) as f:
            self.assertEqual(json.load(f)["commit"], head)
        # census-lite (#1938) reads a JSONL log by built_at + override_reason
        self.assertRegex(r["built_at"], r"^\d{4}-\d\d-\d\dT")

    def test_prune_keeps_three(self):
        for i in range(5):
            if i:
                self.lane_commit(f"c{i}")
            self.run_script(check_ok=True)
        rels = self.releases()
        self.assertEqual(len(rels), 3, rels)
        self.assertIn(self.target(), rels)
        self.assertNotIn(True, [r.endswith("-migrated") for r in rels], "the legacy release aged out")

    def test_prune_never_removes_current_or_previous(self):
        for i in range(3):
            if i:
                self.lane_commit(f"c{i}")
            self.run_script(check_ok=True)
        self.run_script("--rollback", check_ok=True)  # current = 2nd deploy, previous = 3rd
        cur = self.target()
        self.lane_commit("c3")
        self.run_script("--keep", "1", check_ok=True)
        rels = self.releases()
        self.assertEqual(len(rels), 2, rels)
        self.assertIn(cur, rels, "the release that was live before this deploy (previous) survives --keep 1")
        self.assertIn(self.target(), rels)

    def test_rollback_flips_to_previous_and_records(self):
        self.run_script(check_ok=True)
        first = self.target()
        self.lane_commit("second")
        self.run_script(check_ok=True)
        second = self.target()
        self.assertNotEqual(first, second)
        _, out = self.run_script("--rollback", check_ok=True)
        self.assertEqual(self.target(), first)
        r = self.records()[-1]
        self.assertEqual(r["action"], "rollback")
        self.assertEqual(r["previous_release"], second)
        self.assertTrue(r["release_dir"].endswith(first))
        self.assertIsNone(r["override_reason"])
        self.assertIn(r["bundle"]["name"], self.served_index())
        # a second rollback flips back (previous is the one we left)
        self.run_script("--rollback", check_ok=True)
        self.assertEqual(self.target(), second)

    def test_rollback_without_symlink_refused(self):
        self.run_script("--rollback", check_ok=False)

    def test_prints_served_bundle_hint(self):
        _, out = self.run_script(check_ok=True)
        self.assertIn("curl", out)
        self.assertIn(self.records()[-1]["bundle"]["name"], out)

    def test_frontdoor_request_loop_sees_no_503_across_migration_and_flips(self):
        # The spec measurement (dist_deploy_provenance_pinned): a request loop
        # against the REAL frontdoor during the swap sees no 503. The frontdoor
        # opens APP_DIST/index.html per request — through the symlink.
        import threading
        import warnings
        warnings.simplefilter("ignore", ResourceWarning)  # the shared harness's log handle
        sys.path.insert(0, HERE)
        import test_frontdoor as tf
        shard = tf.FakeShard(1)
        fd = tf.Frontdoor(self.tmp, table=tf.routing_table([(1, shard.port)]),
                          extra_env={"AMICODE_APP_DIST": self.link(),
                                     "AMICODE_UI_FLOOR": os.path.join(self.tmp, "no-floor.json")})
        fd.start()
        statuses, stop = {}, threading.Event()

        def loop():
            while not stop.is_set():
                st, _, _ = tf.http_request(fd.port, "/", timeout=5)
                statuses[st] = statuses.get(st, 0) + 1

        t = threading.Thread(target=loop, daemon=True)
        try:
            t.start()
            time.sleep(0.3)
            self.run_script(check_ok=True)           # first run: legacy dir → symlink
            self.lane_commit("second")
            self.run_script(check_ok=True)
            for _ in range(10):
                self.run_script("--rollback", check_ok=True)
            time.sleep(0.3)
        finally:
            stop.set()
            t.join(10)
            fd.stop()
            shard.stop()
        self.assertGreater(sum(statuses.values()), 50, statuses)
        self.assertEqual(set(statuses), {200}, f"non-200 during deploys: {statuses}")
        print(f"\n  frontdoor GET / during 12 flips: {statuses}", file=sys.stderr)


class StaticChecks(unittest.TestCase):
    def test_bash_syntax(self):
        r = subprocess.run(["bash", "-n", SCRIPT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    @unittest.skipUnless(shutil.which("shellcheck"), "shellcheck not installed")
    def test_shellcheck(self):
        r = subprocess.run(["shellcheck", SCRIPT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
