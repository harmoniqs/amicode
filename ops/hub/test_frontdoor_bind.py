"""The frontdoor binds loopback by default; LAN exposure is an explicit opt-in."""
import os, socket, subprocess, sys, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def free_pair():
    for _ in range(50):
        a = socket.socket(); a.bind(("127.0.0.1", 0)); p = a.getsockname()[1]; a.close()
        try:
            b = socket.socket(); b.bind(("0.0.0.0", p + 1)); b.close(); return p
        except OSError:
            continue
    raise RuntimeError("no free port pair")


def listening_addr(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        out = subprocess.run(["ss", "-ltnH", f"sport = :{port}"], capture_output=True, text=True).stdout
        if out.strip():
            return out.split()[3].rsplit(":", 1)[0]
        time.sleep(0.2)
    return None


class FrontdoorBind(unittest.TestCase):
    def run_fd(self, env_extra):
        port = free_pair()
        env = dict(os.environ, AMICODE_FRONTDOOR_PORT=str(port), **env_extra)
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "hub-frontdoor.py")], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            return listening_addr(port), listening_addr(port + 1)
        finally:
            p.terminate(); p.wait(timeout=10)

    def test_default_is_loopback(self):
        self.assertEqual(self.run_fd({}), ("127.0.0.1", "127.0.0.1"))

    def test_explicit_lan_opt_in(self):
        self.assertEqual(self.run_fd({"AMICODE_FRONTDOOR_BIND": "0.0.0.0"}), ("0.0.0.0", "0.0.0.0"))


if __name__ == "__main__":
    unittest.main()
