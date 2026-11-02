#!/usr/bin/env python3
"""test_solve_guard.py — stdlib suite for the restart guard (amicode#2044 / A0).

Real processes, no mocking of the guard's decision. "Compute" is a genuine
sleeping process: a copy of /bin/sleep named `julia` (its comm is `julia`), or
named `solver` for the long-running-non-julia rule. The guard is pointed at a
FABRICATED cgroup tree (SOLVE_GUARD_CGROUP_ROOT) whose cgroup.procs lists those
real pids. Only the parts that touch the system are stubbed on PATH
(systemctl / pgrep / curl / gdb / lsof) so a restart is recorded, never made.

SAFETY: HOME, every log, lock, override and alert path is a temp dir; nothing
under ~/.amico or ~/.config/systemd is read for decisions or written; no unit is
ever restarted, and the only processes killed are ones this suite spawned.

Run: python3 ops/hub/test_solve_guard.py   (exit 0 on pass)
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
OPS = os.path.dirname(HERE)
GUARD = os.path.join(HERE, "solve-guard.sh")
WATCHDOG = os.path.join(HERE, "fleet-watchdog", "rss-watchdog.sh")
HUB_RESTART = os.path.join(OPS, "hub-restart.sh")
LANE_ROLL = os.path.join(HERE, "lane-roll.sh")
WITNESS = os.path.join(HERE, "restart-witness.sh")
DRIFT = os.path.join(HERE, "ops-drift-check.sh")

UNIT = "co.test-server@9.service"
# systemd escapes '-' in slice names as a literal backslash-x2d directory name
CGPATH = "app.slice/app-co.test\\x2dserver.slice/" + UNIT


def slurp(path):
    with open(path) as f:
        return f.read()


def spit(path, text):
    with open(path, "w") as f:
        f.write(text)


def sh_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="solveguard-")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.cgroot = os.path.join(self.tmp, "cgroot")
        self.cgdir = os.path.join(self.cgroot, CGPATH)
        os.makedirs(self.cgdir)
        spit(os.path.join(self.cgdir, "cgroup.procs"), "")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        shutil.copy("/bin/sleep", os.path.join(self.bin, "julia"))
        shutil.copy("/bin/sleep", os.path.join(self.bin, "solver"))
        self.locks = os.path.join(self.tmp, "locks")
        self.overrides = os.path.join(self.tmp, "overrides")
        os.makedirs(self.overrides)
        self.log = os.path.join(self.tmp, "decisions.log")
        self.spawned = os.path.join(self.tmp, "spawned.pids")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            try:
                p.kill()
                p.wait(timeout=5)
            except Exception:
                pass
        # processes spawned by a guarded command (orphans) — ours, by pid file
        if os.path.exists(self.spawned):
            for line in slurp(self.spawned).split():
                try:
                    os.kill(int(line), signal.SIGKILL)
                except Exception:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- fabricated compute --------------------------------------------------
    def procs_file(self, sub=""):
        d = os.path.join(self.cgdir, sub) if sub else self.cgdir
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, "cgroup.procs")

    def add_to_cgroup(self, pid, sub=""):
        with open(self.procs_file(sub), "a") as f:
            f.write(f"{pid}\n")

    def spawn(self, argv, sub="", register=True):
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        self.procs.append(p)
        if register:
            self.add_to_cgroup(p.pid, sub)
        return p

    def julia(self, sub=""):
        return self.spawn([os.path.join(self.bin, "julia"), "300"], sub)

    # -- environment ---------------------------------------------------------
    def env(self, **extra):
        e = {k: v for k, v in os.environ.items()
             if not k.startswith("SOLVE_GUARD_") and not k.startswith("WATCHDOG_")
             and k not in ("BUN_INSPECT", "AMICODE_ENGINE_INSPECT", "AMICODE_SHARD_INDEX", "AMICODE_REPO")}
        e.update({
            "HOME": self.home,
            "SOLVE_GUARD_CGROUP_ROOT": self.cgroot,
            "SOLVE_GUARD_CGROUP_PATH": CGPATH,
            "SOLVE_GUARD_LOCK_DIR": self.locks,
            "SOLVE_GUARD_LOG": self.log,
            "SOLVE_GUARD_OVERRIDE_DIR": self.overrides,
            "SOLVE_GUARD_RECHECK_DELAY": "0.2",
            "SOLVE_GUARD_MAIN_PID": "0",
        })
        e.update(extra)
        return e

    def guard(self, *args, timeout=60, **extra_env):
        return subprocess.run(["bash", GUARD, *args], env=self.env(**extra_env),
                              capture_output=True, text=True, timeout=timeout)

    def decisions(self):
        if not os.path.exists(self.log):
            return []
        return [json.loads(l) for l in slurp(self.log).splitlines() if l.strip()]

    def touch_cmd(self, name="restarted"):
        path = os.path.join(self.tmp, name)
        return path, ["touch", path]


class TestGuardDecision(Base):
    def test_julia_in_cgroup_refuses_without_running_cmd(self):
        jp = self.julia()
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "unit-test", "--", *cmd)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertFalse(os.path.exists(marker), "the restart command must not run")
        self.assertIn(str(jp.pid), r.stderr)
        self.assertIn("julia", r.stderr)
        d = self.decisions()
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["decision"], "refused")
        self.assertEqual(d[0]["unit"], UNIT)
        self.assertEqual(d[0]["caller"], "unit-test")
        self.assertIn("ts", d[0])
        self.assertEqual([p["pid"] for p in d[0]["protected"]], [jp.pid])
        self.assertEqual(d[0]["protected"][0]["comm"], "julia")
        self.assertIn("etimes", d[0]["protected"][0])
        self.assertIn("cmd", d[0]["protected"][0])

    def test_descends_into_child_cgroups_and_escaped_slice_names(self):
        jp = self.julia(sub="sub-scope.scope/leaf")
        r = self.guard("check", UNIT)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn(str(jp.pid), r.stderr)

    def test_check_clear_exits_zero(self):
        r = self.guard("check", UNIT)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_helper_shell_alone_is_allowed_and_cmd_runs(self):
        # a short-lived tool shell: comm=bash, young
        self.spawn(["bash", "-c", "sleep 30; :"])
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "unit-test", "--", *cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(marker))
        d = self.decisions()
        self.assertEqual([x["decision"] for x in d], ["allow"])
        self.assertEqual(d[0]["protected"], [])

    def test_old_infrastructure_process_is_not_protected(self):
        self.spawn(["bash", "-c", "sleep 30; :"])
        time.sleep(2.2)
        r = self.guard("check", UNIT, SOLVE_GUARD_MIN_AGE="1")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_old_non_julia_compute_is_protected(self):
        sp = self.spawn([os.path.join(self.bin, "solver"), "300"])
        time.sleep(2.2)
        r = self.guard("check", UNIT, SOLVE_GUARD_MIN_AGE="1")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn(str(sp.pid), r.stderr)

    def test_young_non_julia_is_not_protected(self):
        self.spawn([os.path.join(self.bin, "solver"), "300"])
        r = self.guard("check", UNIT)  # default MIN_AGE 300s
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_main_pid_is_never_protected(self):
        sp = self.spawn([os.path.join(self.bin, "solver"), "300"])
        time.sleep(2.2)
        r = self.guard("check", UNIT, SOLVE_GUARD_MIN_AGE="1", SOLVE_GUARD_MAIN_PID=str(sp.pid))
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_julia_language_server_is_ignored(self):
        # comm=julia but the cmdline is the editor's LanguageServer
        lsp = os.path.join(self.tmp, "lsp")
        os.makedirs(lsp)
        shutil.copy("/bin/bash", os.path.join(lsp, "julia"))  # a bash whose comm is "julia"
        self.spawn([os.path.join(lsp, "julia"), "-c", "sleep 30; :", "LanguageServer"])
        r = self.guard("check", UNIT)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_missing_cgroup_root_fails_closed(self):
        r = self.guard("check", UNIT, SOLVE_GUARD_CGROUP_ROOT=os.path.join(self.tmp, "nope"))
        self.assertEqual(r.returncode, 3, "an unreadable cgroup tree must not read as clear")

    def test_lookup_through_systemctl_show(self):
        stub = os.path.join(self.tmp, "stubbin")
        os.makedirs(stub)
        with open(os.path.join(stub, "systemctl"), "w") as f:
            f.write("#!/bin/bash\n"
                    'case "$*" in\n'
                    f"  *ControlGroup*) printf '%s\\n' {sh_quote('/' + CGPATH)} ;;\n"
                    "  *MainPID*) echo 0 ;;\n"
                    "esac\n")
        os.chmod(os.path.join(stub, "systemctl"), 0o755)
        e = self.env()
        del e["SOLVE_GUARD_CGROUP_PATH"]
        del e["SOLVE_GUARD_MAIN_PID"]
        e["PATH"] = stub + ":" + e["PATH"]
        jp = self.julia()
        r = subprocess.run(["bash", GUARD, "check", UNIT], env=e, capture_output=True, text=True)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn(str(jp.pid), r.stderr)

    def test_defer_flag_logs_deferred(self):
        self.julia()
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "watchdog", "--defer", "--", *cmd)
        self.assertEqual(r.returncode, 3)
        self.assertEqual([x["decision"] for x in self.decisions()], ["deferred"])


class TestOrphanPrecompileExemption(Base):
    """amicode#2087 — only a provably abandoned precompile worker is exempt."""

    PRECOMP = ["--output-o", "/tmp/x/compiled/v1.12/CairoMakie"]

    def julia_bash(self):
        # a bash whose comm is `julia`: sleeps (state S) unless told to spin
        d = os.path.join(self.tmp, "jbash")
        os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, "julia")
        if not os.path.exists(dst):
            shutil.copy("/bin/bash", dst)
        return dst

    def spawn_orphan(self, extra, script="sleep 300; :", register=True):
        """Double-fork a `julia` so its parent is NOT this test or the fake unit."""
        julia = self.julia_bash()
        argv = " ".join(sh_quote(a) for a in ["-c", script, *extra])
        pidfile = os.path.join(self.tmp, "orphan.pid%d" % len(self.procs))
        subprocess.run(["bash", "-c",
                        f"( {sh_quote(julia)} {argv} >/dev/null 2>&1 </dev/null & echo $! > {sh_quote(pidfile)} ) &"
                        " wait"], check=True)
        for _ in range(100):
            if os.path.exists(pidfile) and slurp(pidfile).strip():
                break
            time.sleep(0.05)
        pid = int(slurp(pidfile).strip())
        with open(self.spawned, "a") as f:
            f.write(f"{pid}\n")
        if register:
            self.add_to_cgroup(pid)
        return pid

    def check(self, **env):
        env.setdefault("SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE", "1")
        return self.guard("check", UNIT, **env)

    def test_orphaned_sleeping_old_precompile_worker_is_exempt(self):
        pid = self.spawn_orphan(self.PRECOMP)
        time.sleep(2.2)
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"solve-guard: exempt {pid} julia", r.stderr)
        self.assertIn("orphaned-precompile", r.stderr)
        self.assertIn("--output-o", r.stderr)

    def test_exemption_is_in_the_decision_log(self):
        pid = self.spawn_orphan(self.PRECOMP)
        time.sleep(2.2)
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "unit-test", "--", *cmd, SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(marker))
        d = self.decisions()
        self.assertEqual([x["decision"] for x in d], ["allow"])
        self.assertEqual(d[0]["protected"], [])
        ex = d[0]["exempt"]
        self.assertEqual([e["pid"] for e in ex], [pid])
        self.assertEqual(ex[0]["comm"], "julia")
        self.assertGreaterEqual(ex[0]["etimes"], 1)
        self.assertIn("--output-o", ex[0]["cmd"])
        self.assertEqual(ex[0]["reason"], "orphaned-precompile")

    def test_no_exempt_key_when_nothing_exempt(self):
        marker, cmd = self.touch_cmd()
        self.guard("run", UNIT, "unit-test", "--", *cmd)
        self.assertNotIn("exempt", self.decisions()[0])

    def test_younger_than_the_bound_is_protected(self):
        self.spawn_orphan(self.PRECOMP)
        time.sleep(1.2)
        r = self.check(SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE="600")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertNotIn("exempt", r.stderr.replace("exempt-", ""))

    def test_default_bound_is_thirty_minutes(self):
        self.spawn_orphan(self.PRECOMP)
        time.sleep(2.2)
        r = self.guard("check", UNIT)  # default 1800 s
        self.assertEqual(r.returncode, 3, r.stderr)

    def test_running_precompile_worker_is_protected(self):
        self.spawn_orphan(self.PRECOMP, script="while :; do :; done")
        time.sleep(2.2)
        r = self.check()
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertNotIn("exempt", r.stderr)

    def test_parent_inside_the_unit_is_protected(self):
        julia = self.julia_bash()
        # parent (a plain bash) forks the julia child and stays alive; both are listed
        parent = self.spawn(["bash", "-c",
                             f"{sh_quote(julia)} -c 'sleep 300; :' --output-o /tmp/x & wait"])
        time.sleep(0.5)
        kids = subprocess.run(["pgrep", "-P", str(parent.pid)], capture_output=True, text=True).stdout.split()
        self.assertEqual(len(kids), 1, kids)
        self.add_to_cgroup(kids[0])
        time.sleep(2.0)
        r = self.check()
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn(f"protected {kids[0]} julia", r.stderr)
        self.assertNotIn("solve-guard: exempt", r.stderr)

    def test_no_precompile_flag_is_protected(self):
        self.spawn_orphan(["--project=/tmp/x", "script.jl"])
        time.sleep(2.2)
        r = self.check()
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertNotIn("solve-guard: exempt", r.stderr)

    def test_flag_that_only_contains_the_substring_is_protected(self):
        self.spawn_orphan(["--output-ox", "/tmp/x"])
        time.sleep(2.2)
        r = self.check()
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertNotIn("solve-guard: exempt", r.stderr)

    def test_equals_form_of_the_flag_is_recognised(self):
        pid = self.spawn_orphan(["--output-o=/tmp/x/CairoMakie.o"])
        time.sleep(2.2)
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"exempt {pid} julia", r.stderr)

    def test_exemption_can_be_disabled(self):
        self.spawn_orphan(self.PRECOMP)
        time.sleep(2.2)
        r = self.check(SOLVE_GUARD_ORPHAN_PRECOMPILE="0")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertNotIn("solve-guard: exempt", r.stderr)

    def test_non_precompile_orphan_old_sleeping_julia_is_protected(self):
        self.spawn_orphan(["-e", "using Pkg; Pkg.test()"])
        time.sleep(2.2)
        r = self.check()
        self.assertEqual(r.returncode, 3, r.stderr)

    def test_mixed_unit_blocks_on_the_real_solve_and_logs_the_orphan(self):
        orphan = self.spawn_orphan(self.PRECOMP)
        solve = self.spawn_orphan(["--check-bounds=yes", "--project=/tmp/x", "script.jl"])
        time.sleep(2.2)
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "unit-test", "--", *cmd, SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE="1")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertFalse(os.path.exists(marker))
        self.assertIn(f"protected {solve} julia", r.stderr)
        self.assertIn(f"exempt {orphan} julia", r.stderr)
        d = self.decisions()[0]
        self.assertEqual(d["decision"], "refused")
        self.assertEqual([p["pid"] for p in d["protected"]], [solve])
        self.assertEqual([e["pid"] for e in d["exempt"]], [orphan])

    def test_unreadable_tree_still_fails_closed(self):
        self.spawn_orphan(self.PRECOMP)
        r = self.check(SOLVE_GUARD_CGROUP_ROOT=os.path.join(self.tmp, "nope"))
        self.assertEqual(r.returncode, 3, r.stderr)


class TestOverrideAndForce(Base):
    def test_override_file_allows_logs_and_is_consumed(self):
        self.julia()
        ov = os.path.join(self.overrides, UNIT)
        spit(ov, "operator: aaron\n")
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "watchdog", "--defer", "--", *cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(marker))
        self.assertFalse(os.path.exists(ov), "the override is single-use")
        d = self.decisions()
        self.assertEqual([x["decision"] for x in d], ["override"])
        self.assertEqual(len(d[0]["protected"]), 1, "the overridden compute is recorded")
        # consumed: the next attempt is refused again
        os.remove(marker)
        r2 = self.guard("run", UNIT, "watchdog", "--defer", "--", *cmd)
        self.assertEqual(r2.returncode, 3)
        self.assertFalse(os.path.exists(marker))

    def test_override_for_another_unit_does_not_apply(self):
        self.julia()
        spit(os.path.join(self.overrides, "co.other.service"), "")
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "x", "--", *cmd)
        self.assertEqual(r.returncode, 3)

    def test_force_env_allows_and_logs(self):
        self.julia()
        marker, cmd = self.touch_cmd()
        r = self.guard("run", UNIT, "hub-restart", "--", *cmd, SOLVE_GUARD_FORCE="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(marker))
        self.assertEqual([x["decision"] for x in self.decisions()], ["force"])


class TestLockAndRecheck(Base):
    def test_compute_appearing_during_recheck_delay_refuses(self):
        marker, cmd = self.touch_cmd()
        p = subprocess.Popen(["bash", GUARD, "run", UNIT, "unit-test", "--", *cmd],
                             env=self.env(SOLVE_GUARD_RECHECK_DELAY="2"),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.8)  # first check passed; we are inside the delay
        self.julia()
        out, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 3, err)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual([x["decision"] for x in self.decisions()], ["refused"])

    def test_check_and_restart_are_serialized_under_one_lock(self):
        out = os.path.join(self.tmp, "out")
        started = os.path.join(self.tmp, "a-started")
        cg = self.procs_file()
        julia = os.path.join(self.bin, "julia")
        # A's "restart": brings compute into the cgroup (as an agent would), holds
        # the lock a moment, then finishes. The orphaned compute must NOT keep the
        # lock (fd closed for the child) — B must still get it afterwards.
        a_cmd = (f"touch {sh_quote(started)}; {sh_quote(julia)} 300 >/dev/null 2>&1 & "
                 f"echo $! >> {sh_quote(cg)}; echo $! >> {sh_quote(self.spawned)}; "
                 f"sleep 1; echo A >> {sh_quote(out)}")
        a = subprocess.Popen(["bash", GUARD, "run", UNIT, "A", "--", "bash", "-c", a_cmd],
                             env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            if os.path.exists(started):
                break
            time.sleep(0.05)
        self.assertTrue(os.path.exists(started), "A never started its command")
        b = subprocess.Popen(["bash", GUARD, "run", UNIT, "B", "--", "bash", "-c",
                              f"echo B >> {sh_quote(out)}"],
                             env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        a.communicate(timeout=30)
        b.communicate(timeout=30)
        self.assertEqual(a.returncode, 0)
        self.assertEqual(b.returncode, 3, "B waited for A's lock, then saw A's compute and refused")
        self.assertEqual(slurp(out).split(), ["A"], "the command never ran twice")
        decisions = [(x["caller"], x["decision"]) for x in self.decisions()]
        self.assertEqual(decisions, [("A", "allow"), ("B", "refused")])

    def test_two_clear_runs_both_complete_serially(self):
        out = os.path.join(self.tmp, "out")
        cmd = ["bash", "-c", f"echo start >> {sh_quote(out)}; sleep 0.5; echo end >> {sh_quote(out)}"]
        ps = [subprocess.Popen(["bash", GUARD, "run", UNIT, f"c{i}", "--", *cmd], env=self.env(),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(2)]
        for p in ps:
            p.communicate(timeout=30)
            self.assertEqual(p.returncode, 0)
        self.assertEqual(slurp(out).split(), ["start", "end", "start", "end"])


# -- stubs for the system-touching parts -------------------------------------
STUB_SYSTEMCTL = """#!/bin/bash
echo "$*" >> "$STUB_LOG"
case "$*" in *is-active*) echo active ;; esac
exit 0
"""
STUB_CURL = """#!/bin/bash
echo "$*" >> "$STUB_CURL_LOG"
[ -f "$STUB_SILENT" ] && exit 28
for a in "$@"; do case "$a" in *127.0.0.1:4096*) echo -n 200 ;; esac; done
exit 0
"""
STUB_PGREP = """#!/bin/bash
[ -n "${STUB_ENGINE_PID:-}" ] && echo "$STUB_ENGINE_PID"
exit 0
"""
STUB_NOOP = "#!/bin/bash\nexit 0\n"


class StubBase(Base):
    def setUp(self):
        super().setUp()
        self.stubbin = os.path.join(self.tmp, "stubbin")
        os.makedirs(self.stubbin)
        for name, body in (("systemctl", STUB_SYSTEMCTL), ("curl", STUB_CURL), ("pgrep", STUB_PGREP),
                           ("gdb", STUB_NOOP), ("lsof", STUB_NOOP)):
            p = os.path.join(self.stubbin, name)
            with open(p, "w") as f:
                f.write(body)
            os.chmod(p, 0o755)
        self.stub_log = os.path.join(self.tmp, "systemctl.calls")
        self.curl_log = os.path.join(self.tmp, "curl.calls")
        self.silent = os.path.join(self.tmp, "silent.flag")
        self.logdir = os.path.join(self.tmp, "wdlog")
        self.alertdir = os.path.join(self.tmp, "alerts")
        self.secret = os.path.join(self.tmp, "secret.env")
        self.engine = self.spawn(["sleep", "300"], register=False)  # the "engine": real pid for ps rss

    def senv(self, **extra):
        e = self.env(
            PATH=self.stubbin + ":" + os.environ["PATH"],
            STUB_LOG=self.stub_log, STUB_CURL_LOG=self.curl_log, STUB_SILENT=self.silent,
            STUB_ENGINE_PID=str(self.engine.pid),
            WATCHDOG_LOG_DIR=self.logdir, WATCHDOG_ALERT_DIR=self.alertdir,
            WATCHDOG_SECRET_FILE=self.secret, WATCHDOG_POST_RESTART_SLEEP="0",
            WATCHDOG_SERVICE=UNIT, WATCHDOG_PATTERN="stub-engine", WATCHDOG_HEALTH_PORT="1",
        )
        e.update(extra)
        return e

    def restarts(self):
        if not os.path.exists(self.stub_log):
            return []
        return [l for l in slurp(self.stub_log).splitlines() if "restart" in l]

    def wd_log(self):
        p = os.path.join(self.logdir, "rss-trajectory.log")
        return slurp(p) if os.path.exists(p) else ""

    def watchdog(self, **extra):
        return subprocess.run(["bash", WATCHDOG], env=self.senv(**extra), capture_output=True,
                              text=True, timeout=120)

    def set_silent(self, on=True):
        if on:
            spit(self.silent, "")
        elif os.path.exists(self.silent):
            os.remove(self.silent)


class TestWatchdog(StubBase):
    # rss over threshold + HTTP silent => restart branch 1
    RSS = dict(WATCHDOG_THRESHOLD_KB="1")
    # rss far below threshold; liveness-alone branch 2
    LIVE = dict(WATCHDOG_THRESHOLD_KB="999999999")

    def test_rss_branch_is_deferred_while_julia_is_in_the_cgroup(self):
        self.julia()
        self.set_silent()
        r = self.watchdog(**self.RSS)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.restarts(), [], "systemctl restart must NOT be invoked")
        self.assertIn("deferred", [x["decision"] for x in self.decisions()])
        self.assertEqual(slurp(os.path.join(self.logdir, f"defer-count-{UNIT}")).strip(), "1")
        self.assertIn("restart-deferred", self.wd_log())

    def test_rss_branch_restarts_when_clear_and_resets_the_counter(self):
        self.set_silent()
        os.makedirs(self.logdir, exist_ok=True)
        spit(os.path.join(self.logdir, f"defer-count-{UNIT}"), "5\n")
        r = self.watchdog(**self.RSS)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.restarts()), 1)
        self.assertIn(f"--user restart {UNIT}", self.restarts()[0])
        self.assertIn("allow", [x["decision"] for x in self.decisions()])
        self.assertFalse(os.path.exists(os.path.join(self.logdir, f"defer-count-{UNIT}")))
        self.assertIn("reason=rss-over-threshold-and-http-silent", self.wd_log())

    def test_serving_engine_is_never_restarted_whatever_its_rss(self):
        r = self.watchdog(**self.RSS)  # serving (curl exit 0)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.restarts(), [])
        self.assertIn("rss-high-but-serving", self.wd_log())

    def test_liveness_alone_branch_needs_two_silent_ticks_and_goes_through_the_guard(self):
        self.julia()
        self.set_silent()
        self.watchdog(**self.LIVE)  # tick 1: arms
        self.assertIn("http-silent-first-tick", self.wd_log())
        self.assertTrue(os.path.exists(os.path.join(self.logdir, "http-silent-tick")))
        self.assertEqual(self.restarts(), [])
        self.watchdog(**self.LIVE)  # tick 2: wants to restart, guard defers
        self.assertEqual(self.restarts(), [], "julia in the group: no restart")
        self.assertIn("deferred", [x["decision"] for x in self.decisions()])
        self.assertTrue(os.path.exists(os.path.join(self.logdir, "http-silent-tick")),
                        "the armed marker survives a deferral so the next tick retries")
        # compute finishes -> next silent tick restarts
        self.engine_clear()
        self.watchdog(**self.LIVE)
        self.assertEqual(len(self.restarts()), 1)
        self.assertIn("reason=http-silent-two-ticks", self.wd_log())
        self.assertFalse(os.path.exists(os.path.join(self.logdir, "http-silent-tick")))

    def engine_clear(self):
        spit(self.procs_file(), "")

    def test_liveness_alone_restarts_when_clear(self):
        self.set_silent()
        self.watchdog(**self.LIVE)
        self.watchdog(**self.LIVE)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual([x["decision"] for x in self.decisions()], ["allow"])

    def test_one_silent_blip_does_not_restart_and_healthy_tick_clears_the_marker(self):
        self.set_silent()
        self.watchdog(**self.LIVE)
        self.set_silent(False)
        self.watchdog(**self.LIVE)
        self.assertEqual(self.restarts(), [])
        self.assertFalse(os.path.exists(os.path.join(self.logdir, "http-silent-tick")))

    def test_markers_are_per_shard(self):
        self.set_silent()
        self.watchdog(AMICODE_SHARD_INDEX="3", WATCHDOG_THRESHOLD_KB="999999999")
        self.assertTrue(os.path.exists(os.path.join(self.logdir, "http-silent-tick-shard3")))
        self.assertFalse(os.path.exists(os.path.join(self.logdir, "http-silent-tick")))

    def test_bounded_deferral_alerts_keeps_deferring_and_override_forces(self):
        self.julia()
        self.set_silent()
        env = dict(WATCHDOG_THRESHOLD_KB="1", WATCHDOG_DEFER_ALERT_TICKS="2")
        self.watchdog(**env)
        alert = os.path.join(self.alertdir, f"live-compute-deferred-{UNIT}")
        self.assertFalse(os.path.exists(alert), "no alert before the bound")
        self.watchdog(**env)
        self.assertTrue(os.path.exists(alert), "alert marker at the bound")
        self.assertIn("alert", [x["decision"] for x in self.decisions()])
        self.watchdog(**env)  # keeps deferring after the alert
        self.assertEqual(self.restarts(), [])
        self.assertEqual(slurp(os.path.join(self.logdir, f"defer-count-{UNIT}")).strip(), "3")
        # human override
        ov = os.path.join(self.overrides, UNIT)
        spit(ov, "")
        self.watchdog(**env)
        self.assertEqual(len(self.restarts()), 1)
        self.assertFalse(os.path.exists(ov))
        self.assertIn("override", [x["decision"] for x in self.decisions()])
        self.assertFalse(os.path.exists(alert), "alert cleared once the restart happened")

    def test_gateway_secret_aware_probe_is_kept(self):
        spit(self.secret, "AMICODE_ENGINE_SHARED_SECRET=abc123\n")
        self.watchdog(**self.LIVE)
        self.assertIn("X-Amicode-Gateway-Secret: abc123", slurp(self.curl_log))

    def test_per_shard_pattern_is_port_specific_with_and_without_an_index(self):
        def pat(idx):
            e = {k: v for k, v in self.env().items()}
            if idx:
                e["AMICODE_SHARD_INDEX"] = idx
            r = subprocess.run(["bash", WATCHDOG, "--print-shard-env"], env=e, capture_output=True, text=True)
            return dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
        legacy, s2, s3 = pat(None), pat("2"), pat("3")
        self.assertTrue(legacy["pattern"].endswith("serve --port 4094"), legacy)
        self.assertTrue(s2["pattern"].endswith("serve --port 4194"), s2)
        self.assertTrue(s3["pattern"].endswith("serve --port 4294"), s3)
        self.assertEqual(legacy["service"], "co.harmoniqs.amicode-server.service")


class TestStaticShape(unittest.TestCase):
    def test_exactly_one_canonical_watchdog(self):
        self.assertFalse(os.path.exists(os.path.join(OPS, "fleet-watchdog", "rss-watchdog.sh")),
                         "the duplicate top-level fleet-watchdog copy must be gone")
        src = slurp(WATCHDOG)
        self.assertIn("http-silent-two-ticks", src)
        self.assertIn("X-Amicode-Gateway-Secret", src)
        self.assertIn("SILENT_MARKER", src)

    def test_every_restart_goes_through_the_guard(self):
        for path in (WATCHDOG, LANE_ROLL, HUB_RESTART):
            lines = [l for l in slurp(path).splitlines()
                     if "systemctl --user restart" in l and not l.lstrip().startswith("#")]
            self.assertTrue(lines, f"{path} should contain a guarded restart")
            for l in lines:
                self.assertIn("-- systemctl --user restart", l, f"unguarded restart in {path}: {l}")

    def test_no_stale_references_to_the_removed_watchdog_dir(self):
        r = subprocess.run(["grep", "-rn", "ops/" + "fleet-watchdog", OPS, "--include=*.sh", "--include=*.md",
                            "--include=*.py", "--include=*.service", "--include=*.timer"],
                           capture_output=True, text=True)
        stale = [l for l in r.stdout.splitlines() if "test_solve_guard.py" not in l]
        self.assertEqual(stale, [])

    def test_scripts_parse(self):
        for p in (GUARD, WATCHDOG, HUB_RESTART, LANE_ROLL, WITNESS, DRIFT):
            r = subprocess.run(["bash", "-n", p], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{p}: {r.stderr}")
        sc = shutil.which("shellcheck") or os.environ.get("AMICODE_SHELLCHECK")
        if not sc:
            return
        for p in (GUARD, WATCHDOG, HUB_RESTART, LANE_ROLL, WITNESS, DRIFT):
            r = subprocess.run([sc, "-S", "warning", p], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{p}: {r.stdout}")


class TestHubRestart(StubBase):
    def hr(self, *args, **extra):
        return subprocess.run(["bash", HUB_RESTART, *args],
                              env=self.senv(HUB_RESTART_UNIT=UNIT, AMICODE_SERVER_PORT="4096", **extra),
                              capture_output=True, text=True, timeout=120)

    def test_refuses_by_default_when_compute_is_in_the_group(self):
        self.julia()
        r = self.hr("restart")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(self.restarts(), [])
        self.assertEqual([x["decision"] for x in self.decisions()], ["refused"])
        self.assertEqual(self.decisions()[0]["caller"], "hub-restart")

    def test_restarts_as_before_when_clear(self):
        r = self.hr("restart")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual([x["decision"] for x in self.decisions()], ["allow"])

    def test_force_flag_restarts_through_compute_and_is_logged(self):
        self.julia()
        r = self.hr("restart", "--force")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual([x["decision"] for x in self.decisions()], ["force"])

    def test_force_flag_position_does_not_matter(self):
        self.julia()
        r = self.hr("--force", "restart")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual([x["decision"] for x in self.decisions()], ["force"])

    def test_verify_mode_is_not_guarded(self):
        self.julia()
        r = self.hr("verify")
        self.assertEqual(self.restarts(), [])
        self.assertEqual(self.decisions(), [])

    def test_missing_guard_fails_closed(self):
        r = self.hr("restart", SOLVE_GUARD_SCRIPT=os.path.join(self.tmp, "no-such-guard.sh"))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.restarts(), [])


class TestLaneRoll(StubBase):
    def lr(self):
        done = os.path.join(self.tmp, "done")
        os.makedirs(done, exist_ok=True)
        sha = os.path.join(self.home, ".amico", "server", "bin")
        os.makedirs(sha, exist_ok=True)
        spit(os.path.join(sha, "opencode.CANONICAL-sha"), "deadbeef\n")
        self.done = done
        e = self.senv(LANE_ROLL_DONE_DIR=done, LANE_ROLL_LOG=os.path.join(self.tmp, "lane-roll.log"),
                      LANE_ROLL_IDLE_GAP="0.2", LANE_ROLL_TICK="0.5", LANE_ROLL_SETTLE="0",
                      LANE_ROLL_DEADLINE_S="3", STUB_ENGINE_PID="")
        # idle sessions: the curl stub answers {} for session/status
        with open(os.path.join(self.stubbin, "curl"), "w") as f:
            f.write("#!/bin/bash\necho '{}'\n")
        return subprocess.run(["bash", LANE_ROLL], env=e, capture_output=True, text=True, timeout=60)

    def test_blocked_shard_is_not_restarted_and_not_marked_done(self):
        self.julia()
        r = self.lr()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.restarts(), [])
        self.assertEqual(os.listdir(self.done), [], "a deferred shard must be retried, not marked done")
        self.assertIn("deferred", [x["decision"] for x in self.decisions()])
        self.assertIn("deferred", slurp(os.path.join(self.tmp, "lane-roll.log")))

    def test_clear_shard_rolls_and_is_marked_done(self):
        r = self.lr()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertGreaterEqual(len(self.restarts()), 1)
        self.assertIn("lane-roll-2.done", os.listdir(self.done))


class TestWitness(Base):
    def setUp(self):
        super().setUp()
        self.runs = os.path.join(self.tmp, "runs")
        self.starts = os.path.join(self.tmp, "starts.txt")
        self.t0 = 1_800_000_000  # fixed epoch for the fabricated restarts

    def iso(self, epoch, off="+0000"):
        # the wall-clock string for the SAME instant in the given UTC offset
        secs = (1 if off[0] == "+" else -1) * (int(off[1:3]) * 3600 + int(off[3:5]) * 60)
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch + secs)) + off

    def mkrun(self, name, log_age_before_start, start, finished=False):
        d = os.path.join(self.runs, "prob", name)
        os.makedirs(d)
        lp = os.path.join(d, "run.log")
        spit(lp, "x\n")
        t = start - log_age_before_start
        os.utime(lp, (t, t))
        if finished:
            spit(os.path.join(d, "FINISHED"), "status = ok\n")
        return d

    def witness(self):
        return subprocess.run(["bash", WITNESS], env=self.env(
            SOLVE_WITNESS_STARTS=self.starts, AMICO_RUNS_ROOT=self.runs), capture_output=True, text=True,
            timeout=60)

    def test_losses_are_classified_guarded_or_unguarded(self):
        a_start, b_start = self.t0, self.t0 + 10_000
        spit(self.starts, f"unit-a.service {self.iso(a_start)}\nunit-b.service {self.iso(b_start, '-0400')}\n")
        # a guarded restart of unit-a: an allow 30 s before the start
        with open(self.log, "w") as f:
            f.write(json.dumps({"ts": self.iso(a_start - 30), "caller": "x", "unit": "unit-a.service",
                                "decision": "allow", "protected": []}) + "\n")
        self.mkrun("r-a-lost", 20, a_start)                      # lost under a guarded restart
        self.mkrun("r-a-finished", 20, a_start, finished=True)   # finished: not a loss
        self.mkrun("r-a-old", 300, a_start)                      # stopped >60 s before: not a loss
        # unit-b: the start time is written with a -0400 offset; no decision at all
        self.mkrun("r-b-lost", 5, b_start)
        r = self.witness()
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        rows = [json.loads(l) for l in lines[:-1]]
        by_run = {os.path.basename(x["run_dir"]): x for x in rows}
        self.assertEqual(set(by_run), {"r-a-lost", "r-b-lost"})
        self.assertEqual(by_run["r-a-lost"]["classification"], "guarded")
        self.assertEqual(by_run["r-a-lost"]["unit"], "unit-a.service")
        self.assertEqual(by_run["r-b-lost"]["classification"], "unguarded")
        self.assertEqual(lines[-1], "guarded_losses=1 unguarded_losses=1")

    def test_no_losses_reads_zero(self):
        spit(self.starts, f"unit-a.service {self.iso(self.t0)}\n")
        os.makedirs(self.runs)
        r = self.witness()
        self.assertEqual(r.stdout.strip().splitlines()[-1], "guarded_losses=0 unguarded_losses=0")

    def test_an_allow_for_another_unit_or_too_old_is_unguarded(self):
        spit(self.starts, f"unit-a.service {self.iso(self.t0)}\n")
        with open(self.log, "w") as f:
            f.write(json.dumps({"ts": self.iso(self.t0 - 30), "caller": "x", "unit": "unit-other.service",
                                "decision": "allow", "protected": []}) + "\n")
            f.write(json.dumps({"ts": self.iso(self.t0 - 500), "caller": "x", "unit": "unit-a.service",
                                "decision": "allow", "protected": []}) + "\n")
        self.mkrun("r1", 10, self.t0)
        r = self.witness()
        self.assertEqual(r.stdout.strip().splitlines()[-1], "guarded_losses=0 unguarded_losses=1")


class TestDriftCheck(Base):
    NAMES = ["amicode-server.sh", "deploy-gate.sh", "hub-restart.sh", "lane-roll.sh", "solve-guard.sh",
             "restart-witness.sh", "fleet-watchdog/rss-watchdog.sh"]
    REPO = {"hub-restart.sh": os.path.join(OPS, "hub-restart.sh")}

    def repo_path(self, n):
        return self.REPO.get(n, os.path.join(HERE, n))

    def deploy_all(self, root):
        for n in self.NAMES:
            dst = os.path.join(root, n)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy(self.repo_path(n), dst)

    def drift(self, root):
        return subprocess.run(["bash", DRIFT], env=self.env(DEPLOY_ROOT=root), capture_output=True,
                              text=True, timeout=60)

    def test_identical_deploy_passes(self):
        root = os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        r = self.drift(root)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for n in self.NAMES:
            self.assertIn(n, r.stdout)

    def test_a_changed_file_fails(self):
        root = os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        with open(os.path.join(root, "lane-roll.sh"), "a") as f:
            f.write("# hot fix\n")
        r = self.drift(root)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("DIFF", r.stdout)

    def test_a_missing_deployed_file_fails(self):
        root = os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        os.remove(os.path.join(root, "solve-guard.sh"))
        r = self.drift(root)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("MISSING", r.stdout)

    # -- amicode#2050: the repo root is explicit and verified ----------------
    def drift_args(self, root, *args, repo_env=None, script=DRIFT):
        extra = {"DEPLOY_ROOT": root}
        if repo_env:
            extra["AMICODE_REPO"] = repo_env
        return subprocess.run(["bash", script, *args], env=self.env(**extra), capture_output=True,
                              text=True, timeout=60)

    def make_repo(self, name="repo"):
        """A real temp 'checkout': the markers plus every checked file, laid out as in the repo."""
        repo = os.path.join(self.tmp, name)
        os.makedirs(os.path.join(repo, "packages", "amico-run"))
        for n in self.NAMES:
            dst = os.path.join(repo, "ops", n) if n == "hub-restart.sh" else os.path.join(repo, "ops", "hub", n)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy(self.repo_path(n), dst)
        return repo

    def test_run_from_the_deploy_root_without_a_repo_refuses(self):
        root = os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        shutil.copy(DRIFT, os.path.join(root, "ops-drift-check.sh"))
        r = self.drift_args(root, script=os.path.join(root, "ops-drift-check.sh"))
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        self.assertIn("run from a repository checkout or pass --repo", r.stderr)
        self.assertNotIn("ok", r.stdout)

    def test_explicit_repo_with_a_differing_file_names_it_and_exits_1(self):
        repo, root = self.make_repo(), os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        with open(os.path.join(root, "deploy-gate.sh"), "a") as f:
            f.write("# hot fix\n")
        shutil.copy(DRIFT, os.path.join(root, "ops-drift-check.sh"))
        r = self.drift_args(root, "--repo", repo, script=os.path.join(root, "ops-drift-check.sh"))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        row = [l for l in r.stdout.splitlines() if l.startswith("deploy-gate.sh")]
        self.assertTrue(row and "DIFF" in row[0], r.stdout)
        ok = [l for l in r.stdout.splitlines() if l.startswith("lane-roll.sh")]
        self.assertTrue(ok and " ok " in ok[0], r.stdout)

    def test_explicit_repo_identical_passes_via_flag_and_env(self):
        repo, root = self.make_repo(), os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        shutil.copy(DRIFT, os.path.join(root, "ops-drift-check.sh"))
        script = os.path.join(root, "ops-drift-check.sh")
        r = self.drift_args(root, "--repo", repo, script=script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        r = self.drift_args(root, repo_env=repo, script=script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_repo_root_equal_to_the_deploy_root_refuses(self):
        repo = self.make_repo()
        r = self.drift_args(repo, "--repo", repo)
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        self.assertNotIn(" ok ", r.stdout)
        # a symlink to the same directory is the same directory
        link = os.path.join(self.tmp, "link")
        os.symlink(repo, link)
        r = self.drift_args(link, "--repo", repo)
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)

    def test_a_symlinked_deployed_file_refuses(self):
        repo, root = self.make_repo(), os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        os.remove(os.path.join(root, "lane-roll.sh"))
        os.symlink(os.path.join(repo, "ops", "hub", "lane-roll.sh"), os.path.join(root, "lane-roll.sh"))
        r = self.drift_args(root, "--repo", repo)
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        self.assertIn("lane-roll.sh", r.stderr)
        self.assertNotIn(" ok ", r.stdout)

    def test_an_invalid_repo_root_refuses(self):
        root = os.path.join(self.tmp, "deploy")
        self.deploy_all(root)
        bogus = os.path.join(self.tmp, "notarepo")
        os.makedirs(bogus)
        r = self.drift_args(root, "--repo", bogus)
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        self.assertIn("not a repository checkout", r.stderr)
        r = self.drift_args(root, "--repo", os.path.join(self.tmp, "nonexistent"))
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        r = self.drift_args(root, repo_env=bogus)
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
