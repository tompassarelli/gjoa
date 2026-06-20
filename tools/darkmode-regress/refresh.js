/* Content-context (Marionette executeScript): re-read the CURRENT computed color +
 * rect of the already-tagged (data-gjoa-cn) text elements, WITHOUT re-tagging. The
 * normalize re-measure needs fresh foregrounds after applying correctives, but
 * re-running rects.js would re-tag and could REMAP cn on dynamic pages (elements
 * added/removed between passes), landing the comparison on the wrong nodes. Reading
 * the existing tags keeps cn stable. This mirrors the production actor's single-pass
 * model (it never re-tags). Bare body ending in `return` (no IIFE). */
const parseColor = (s) => { const m = s && s.match(/[\d.]+/g); return (m && m.length >= 3) ? [+m[0], +m[1], +m[2]] : null; };
const W = window.innerWidth, H = window.innerHeight, dpr = window.devicePixelRatio || 1;
const out = [];
for (const el of document.querySelectorAll("[data-gjoa-cn]")) {
  const cn = +el.getAttribute("data-gjoa-cn");
  const r = el.getBoundingClientRect();
  if (r.width < 10 || r.height < 8 || r.top >= H || r.left >= W || r.bottom <= 0 || r.right <= 0) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
  const fg = parseColor(cs.color); if (!fg) continue;
  out.push({ cn, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             fg, tag: el.tagName, text: (el.textContent || "").trim().slice(0, 50) });
}
return { w: W, h: H, dpr, els: out };
