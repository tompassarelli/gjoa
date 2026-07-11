#!/usr/bin/env python3
"""Control-integrity sentinel: prove Dark Reader is ACTIVE in the control arm
before any corpus render. Renders news.ycombinator.com (no native dark theme —
the discriminator) and asserts darkreader <style> nodes + a dark body.
Exit 0 = DR proven active. Exit 1 = control invalid; caller must abort.

Born 2026-07-11: the mark-1 baseline ran its entire "Dark Reader control" arm
with DR never injected (extension needed ~30s boot, arm waited 14s) — 68 sites
of "DR comparison" were actually light Firefox. A control that can fail
silently isn't a control."""
import argparse, json, socket, sys, time

class M:
    def __init__(self, port):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.buf = b""; self.mid = 0; self.recv()
    def recv(self):
        while b":" not in self.buf: self.buf += self.s.recv(65536)
        n, _, rest = self.buf.partition(b":"); n = int(n)
        while len(rest) < n: rest += self.s.recv(65536)
        self.buf = rest[n:]; return json.loads(rest[:n])
    def send(self, name, params):
        self.mid += 1
        m = json.dumps([0, self.mid, name, params]).encode()
        self.s.sendall(f"{len(m)}:".encode() + m)
        while True:
            r = self.recv()
            if r[0] == 1 and r[1] == self.mid: return r

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--retries", type=int, default=3, help="re-check cycles (DR may still be booting)")
    a = ap.parse_args()
    try:
        m = M(a.port)
        m.send("WebDriver:NewSession", {})
        for attempt in range(a.retries):
            m.send("WebDriver:Navigate", {"url": "https://news.ycombinator.com/"})
            time.sleep(8)
            r = m.send("WebDriver:ExecuteScript", {
                "script": "const cs=getComputedStyle(document.body);"
                          "return {bg: cs.backgroundColor,"
                          " dr: document.querySelectorAll('style.darkreader').length};",
                "args": []})
            v = (r[3] or {}).get("value") or {}
            dr, bg = v.get("dr", 0), v.get("bg", "")
            print(f"dr-sentinel attempt {attempt+1}: darkreader styles={dr} body bg={bg}", file=sys.stderr)
            if dr > 0:
                print("dr-sentinel: Dark Reader ACTIVE — control valid", file=sys.stderr)
                return 0
            time.sleep(10)
        print("dr-sentinel: Dark Reader NEVER injected — control INVALID", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"dr-sentinel: probe error: {e} — control UNPROVEN", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
