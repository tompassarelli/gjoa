#!/usr/bin/env python3
# Wave-4 probe: for the LARGEST heading in the top viewport, report (a) content-side
# composition — computed fg, ancestor bg chain, and every element painting under the
# heading's center (elementsFromPoint) — and (b) parent-side drawSnapshot pixels of
# that exact rect (median L*), so we can see WHERE snapshot-vs-paint attribution
# diverges (engine-exempt canvas/late-image backdrops, top-layer dialogs).
# Usage: wave4-probe.py <port> <url> [settle]
import sys, time, socket, json

class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf = b""; self.id = 1; dl = time.time() + timeout; last = None
        while time.time() < dl:
            try:
                self.s = socket.create_connection((host, port), timeout=5); self.s.settimeout(180); break
            except OSError as e:
                last = e; time.sleep(0.3)
        else:
            raise SystemExit(f"connect {host}:{port}: {last}")
        self._frame()
    def _frame(self):
        while b":" not in self.buf:
            self.buf += self.s.recv(65536)
        i = self.buf.index(b":"); n = int(self.buf[:i]); need = i + 1 + n
        while len(self.buf) < need:
            self.buf += self.s.recv(65536)
        p = self.buf[i + 1:need]; self.buf = self.buf[need:]; return json.loads(p.decode())
    def send(self, name, params):
        mid = self.id; self.id += 1
        msg = json.dumps([0, mid, name, params]).encode()
        self.s.sendall(f"{len(msg)}:".encode() + msg)
        while True:
            r = self._frame()
            if isinstance(r, list) and r[0] == 1 and r[1] == mid:
                if r[2]:
                    raise SystemExit(f"{name}: {r[2]}")
                return r[3]
    def newsession(self):
        return self.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}})
    def ctx(self, c):
        self.send("Marionette:SetContext", {"value": c})
    def navigate(self, url):
        try:
            return self.send("WebDriver:Navigate", {"url": url})
        except SystemExit as e:
            return f"NAV {e}"
    def exe(self, s, t=30000):
        r = self.send("WebDriver:ExecuteScript", {"script": s, "args": [], "scriptTimeout": t, "newSandbox": False})
        return r.get("value") if isinstance(r, dict) else r
    def exe_async(self, s, t=30000):
        r = self.send("WebDriver:ExecuteAsyncScript", {"script": s, "args": [], "scriptTimeout": t, "newSandbox": False})
        return r.get("value") if isinstance(r, dict) else r

port = int(sys.argv[1]); url = sys.argv[2]
settle = float(sys.argv[3]) if len(sys.argv) > 3 else 18
m = M(port); m.newsession(); m.ctx("content")
m.navigate("about:blank"); time.sleep(0.3); m.navigate(url); time.sleep(settle)

content_probe = r"""
const out = {};
const cs = el => el ? getComputedStyle(el) : null;
const pr = document.createElement('span');
pr.style.cssText = 'color:#000;position:fixed;left:-9999px'; document.body.appendChild(pr);
out.blackProbeColor = getComputedStyle(pr).color; pr.remove();
// largest visible heading in the top viewport
let best = null, bestA = 0;
for (const h of document.querySelectorAll('h1,h2,[role=heading]')) {
  const r = h.getBoundingClientRect();
  if (r.top < 0 || r.top > innerHeight || r.width < 40 || r.height < 16) continue;
  if (!h.textContent.trim()) continue;
  const a = r.width * r.height;
  if (a > bestA) { bestA = a; best = h; }
}
if (!best) return JSON.stringify({err: 'no heading'});
const r = best.getBoundingClientRect();
out.head = { t: best.textContent.trim().slice(0, 40), fg: cs(best).color,
             x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cn: best.getAttribute('data-gjoa-cn') };
// ancestor bg chain (first 6 non-transparent stops)
const chain = []; let e = best;
while (e && chain.length < 6) {
  const c = cs(e);
  if (c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none')
    chain.push({ tag: e.tagName, cls: String(e.className).slice(0, 30), bg: c.backgroundColor, bgi: c.backgroundImage.slice(0, 60) });
  e = e.parentElement;
}
out.ancChain = chain;
// what actually paints under the heading center
const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
out.stack = document.elementsFromPoint(cx, cy).slice(0, 10).map(el => {
  const c = cs(el);
  const o = { tag: el.tagName, cls: String(el.className).slice(0, 30), bg: c.backgroundColor, bgi: c.backgroundImage.slice(0, 80) };
  if (el.tagName === 'IMG') { o.src = (el.currentSrc || el.src || '').slice(0, 90); o.complete = el.complete; }
  if (el.tagName === 'CANVAS' || el.tagName === 'VIDEO' || el.tagName === 'PICTURE') o.replaced = true;
  return o;
});
// top-layer dialogs (authored vs painted attribution blindness)
out.dialogs = [...document.querySelectorAll('dialog[open], dialog')].slice(0, 3).map(d => {
  const c = cs(d); const dr = d.getBoundingClientRect();
  return { open: d.open, bg: c.backgroundColor, x: Math.round(dr.x), y: Math.round(dr.y),
           w: Math.round(dr.width), h: Math.round(dr.height), cls: String(d.className).slice(0, 30) };
});
return JSON.stringify(out);
"""
info = json.loads(m.exe(content_probe))
print("CONTENT:", json.dumps(info, indent=1))
if "head" in info:
    hx, hy, hw, hh = info["head"]["x"], info["head"]["y"], info["head"]["w"], info["head"]["h"]
    m.ctx("chrome")
    chrome_probe = r"""
const cb = arguments[arguments.length - 1];
(async () => {
  try {
    const bc = gBrowser.selectedBrowser.browsingContext;
    const wgp = bc.currentWindowGlobal;
    const median = (rect) => wgp.drawSnapshot(rect, 1, "rgb(0,0,0)").then(snap => {
      const cv = new OffscreenCanvas(snap.width, snap.height);
      const cx2 = cv.getContext('2d'); cx2.drawImage(snap, 0, 0);
      const d = cx2.getImageData(0, 0, snap.width, snap.height).data;
      const n = snap.width * snap.height; const Ls = new Float64Array(n);
      const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const Y = 0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2]);
        Ls[i] = Y <= 0.008856 ? 903.3 * Y : 116 * Math.cbrt(Y) - 16;
      }
      Ls.sort();
      return { w: snap.width, h: snap.height, medL: +Ls[n >> 1].toFixed(1), p10: +Ls[Math.floor(n * .1)].toFixed(1), p90: +Ls[Math.floor(n * .9)].toFixed(1) };
    });
    const headRect = new DOMRect(%X%, %Y%, %W%, %H%);
    const head = await median(headRect);
    const vp = await median(new DOMRect(0, 0, 1200, 800));
    cb(JSON.stringify({ headRegion: head, viewport: vp }));
  } catch (e) { cb(JSON.stringify({ err: String(e) })); }
})();
""".replace("%X%", str(hx)).replace("%Y%", str(hy)).replace("%W%", str(max(hw, 10))).replace("%H%", str(max(hh, 10)))
    print("PARENT-SNAPSHOT:", m.exe_async(chrome_probe))
