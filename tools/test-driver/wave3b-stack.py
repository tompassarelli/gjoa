#!/usr/bin/env python3
"""Wave-3 W-B paint-stack probe: at sample points, dump the elementsFromPoint
stack with each element's computed paint properties — find WHO paints the
light-gray wash over the (computed-dark) body.
Usage: wave3b-stack.py --port N --url URL --points "x1:y1,x2:y2" [--settle S]
"""
import argparse, json, sys, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
from importlib.machinery import SourceFileLoader
_m = SourceFileLoader("wave3b_probe", __import__("os").path.join(__import__("os").path.dirname(__file__), "wave3b-probe.py")).load_module()
M = _m.M

STACK_JS_TMPL = r"""
const pts = %PTS%;
const win = window, doc = document, out = {};
const describe = (el) => {
  const cs = win.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    sel: el.tagName + (el.id ? "#"+el.id : "") + (el.className && typeof el.className === "string" ? "."+el.className.split(/\s+/).slice(0,3).join(".") : ""),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    bg: cs.backgroundColor,
    bgImage: cs.backgroundImage.slice(0, 160),
    opacity: cs.opacity,
    filter: cs.filter,
    backdropFilter: cs.backdropFilter,
    mixBlendMode: cs.mixBlendMode,
    isolation: cs.isolation,
    position: cs.position,
    zIndex: cs.zIndex,
    transform: cs.transform === "none" ? "none" : "yes",
    colorScheme: cs.colorScheme,
  };
};
out.points = {};
for (const [x, y] of pts) {
  const stack = doc.elementsFromPoint(x, y).slice(0, 12).map(describe);
  out.points[x + ":" + y] = stack;
}
return out;
"""

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--url",required=True)
    ap.add_argument("--points",default="800:400,400:700,1200:600,100:900")
    ap.add_argument("--settle",type=float,default=18.0)
    ap.add_argument("--nonav",action="store_true")
    a=ap.parse_args()
    pts=[[int(p.split(":")[0]),int(p.split(":")[1])] for p in a.points.split(",")]
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(80):
        if m.exe("return !!window.gBrowser;"): break
        time.sleep(0.25)
    m.rect(1600,1000)
    m.ctx("content")
    if not a.nonav:
        m.navigate("about:blank"); time.sleep(0.3)
        m.navigate(a.url); time.sleep(a.settle)
    js = STACK_JS_TMPL.replace("%PTS%", json.dumps(pts))
    r=m.exe(js)
    print(json.dumps(r,indent=1))

if __name__=="__main__": main()
