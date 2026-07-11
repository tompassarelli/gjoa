/* darkcheck-collect.js — DARKCHECK v1 Channel A, CONTENT-context collector
 * (Marionette executeScript; runs as a function body → must `return`, no IIFE).
 *
 * One rendered (engine-on) pass. Per candidate node emits: mechanical ROLE
 * (§3: body/heading/link/control/placeholder-or-disabled), rendered fg, the
 * effective background resolved by an ANCESTOR COMPOSITING WALK with alpha
 * flattening, geometry+area, and font size/weight. When the compositing walk
 * hits a background-image / gradient / not-yet-opaque stack (the wave-3
 * getComputedStyle-lies blind spots) it flags bgIndeterminate — the chrome-side
 * auditor then resolves that node's backdrop from the drawSnapshot pixels.
 *
 * Also exports the page's replaced-content rects (img/video/canvas geometry) —
 * the ONE dumb seam Channel B (pixel masker) consumes: [{x,y,w,h,tag}].
 *
 * Tags each node data-gjoa-dc=<index> so offending-node selectors are stable.
 * The color MATH is not needed here (roles + colors + rects only); the auditor
 * owns APCA. Keep this browser-safe: no engine APIs, plain DOM. */
const W = window.innerWidth, H = window.innerHeight, dpr = window.devicePixelRatio || 1;

const parseColor = (s) => {
  if (!s) return null;
  if (s === "transparent") return [0, 0, 0, 0];
  const m = s.match(/[-\d.]+/g);
  if (!m || m.length < 3) return null;
  return [+m[0], +m[1], +m[2], m.length >= 4 ? +m[3] : 1];
};
// alpha-composite src OVER dst (both [r,g,b,a], a in 0..1) → [r,g,b,a]
const over = (src, dst) => {
  const sa = src[3], da = dst[3];
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  const c = (i) => (src[i] * sa + dst[i] * da * (1 - sa)) / oa;
  return [c(0), c(1), c(2), oa];
};
const relLum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

// engine-inversion probe (same technique as rects.js): a pure-black authored span
// paints light iff the engine is luminance-inverting THIS document.
let inverted = false;
try {
  const pr = document.createElement("span");
  pr.style.cssText = "color:#000;position:fixed;left:-9999px;top:0;";
  (document.body || document.documentElement).appendChild(pr);
  const pc = parseColor(getComputedStyle(pr).color);
  inverted = !!(pc && relLum(pc) > 40);
  pr.remove();
} catch (e) {}

// page-level dark surface: rendered root/body bg, plus the authored color-scheme bit.
const rootCS = document.documentElement ? getComputedStyle(document.documentElement) : null;
const bodyCS = document.body ? getComputedStyle(document.body) : null;
const rootBgRendered = (bodyCS && parseColor(bodyCS.backgroundColor)) ||
  (rootCS && parseColor(rootCS.backgroundColor)) || [255, 255, 255, 1];
const rootBgL = relLum(rootBgRendered);       // 0..255
const colorSchemeDark = !!(rootCS && /dark/.test(rootCS.colorScheme || ""));
const rootDark = colorSchemeDark || rootBgL < 56; // 56/255 ≈ L*22 proxy from spec A7
const normalizedSignal = document.documentElement ? document.documentElement.getAttribute("data-gjoa-normalized") : null;

/* Effective background behind a node's text: walk node→ancestors, compositing each
 * layer's rendered background-color front-to-back (node's own bg frontmost). Stop
 * when the accumulated color is opaque. Returns {rgb:[r,g,b]|null, indeterminate}.
 * indeterminate = a layer carried a background-image/gradient before we reached
 * opacity (a real pixel may sit behind the glyphs) → auditor samples drawSnapshot. */
const effectiveBg = (node) => {
  let acc = [0, 0, 0, 0];
  let el = node;
  let hops = 0;
  while (el && el.nodeType === 1 && hops < 40) {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      // a painted image/gradient may be the backdrop — cannot flatten to one color
      return { rgb: acc[3] > 0 ? [acc[0], acc[1], acc[2]] : null, indeterminate: true };
    }
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg[3] > 0) {
      acc = over(acc, bg);
      if (acc[3] >= 0.999) return { rgb: [acc[0], acc[1], acc[2]], indeterminate: false };
    }
    el = el.parentElement;
    hops++;
  }
  // ran out of ancestors without reaching opacity → composite over the rendered root
  acc = over(acc, [rootBgRendered[0], rootBgRendered[1], rootBgRendered[2], 1]);
  return { rgb: [acc[0], acc[1], acc[2]], indeterminate: false };
};

const CONTROL_TAGS = { INPUT: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1, METER: 1, PROGRESS: 1 };
const CONTROL_ROLES = { button: 1, checkbox: 1, radio: 1, switch: 1, slider: 1, tab: 1, textbox: 1, combobox: 1, searchbox: 1, spinbutton: 1 };
const classifyRole = (el, cs) => {
  const tag = el.tagName, role = (el.getAttribute("role") || "").toLowerCase();
  const disabled = el.disabled === true || el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true";
  if (disabled) return "disabled";
  if (/^H[1-6]$/.test(tag) || role === "heading" || el.hasAttribute("aria-level")) return "heading";
  if (tag === "A" && el.hasAttribute("href")) return "link";
  if (role === "link") return "link";
  if (CONTROL_TAGS[tag] || CONTROL_ROLES[role] || (cs.appearance && cs.appearance !== "none" && cs.appearance !== "auto")) return "control";
  return "body";
};
const hasDirectText = (el) => {
  for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
  return false;
};
const hasUnderline = (cs) => /underline/.test(cs.textDecorationLine || cs.textDecoration || "");
// A6 scoping: a link is an INLINE PROSE link (the only kind the experimental ΔLc rule
// applies to) iff an ancestor is a prose container AND no ancestor is nav/header/footer
// chrome. Nav/menu/breadcrumb links are excluded — they need no body-distinction.
const PROSE = { P: 1, LI: 1, DD: 1, BLOCKQUOTE: 1, TD: 1, FIGCAPTION: 1, ARTICLE: 1 };
const CHROME_LAND = { NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1 };
const inProse = (node) => {
  let el = node.parentElement, prose = false, hops = 0;
  while (el && el.nodeType === 1 && hops < 30) {
    if (CHROME_LAND[el.tagName] || el.getAttribute("role") === "navigation") return false;
    if (PROSE[el.tagName]) prose = true;
    el = el.parentElement; hops++;
  }
  return prose;
};

const out = [];
let dc = 0;
const SEL = "h1,h2,h3,h4,h5,h6,p,a,span,li,td,th,div,button,label,strong,em,blockquote,figcaption,dt,dd,input,select,textarea";
const all = document.body ? document.body.querySelectorAll(SEL) : [];
for (const el of all) {
  const tag = el.tagName;
  const isFormControl = CONTROL_TAGS[tag];
  if (!isFormControl && !hasDirectText(el)) continue;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 6 || r.top >= H || r.left >= W || r.bottom <= 0 || r.right <= 0) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
  const fg = parseColor(cs.color);
  if (!fg) continue;
  const role = classifyRole(el, cs);
  const ownBg = parseColor(cs.backgroundColor);
  const eb = effectiveBg(el);
  el.setAttribute("data-gjoa-dc", dc);
  // placeholder role: an empty text input showing placeholder text
  let effRole = role;
  if (isFormControl && tag === "INPUT" && el.value === "" && el.placeholder) effRole = "placeholder";
  out.push({
    dc, role: effRole, tag,
    sig: tag + "|" + (el.textContent || "").trim().slice(0, 24).replace(/\s+/g, " "),
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    area: Math.round(r.width * r.height),
    fg: [fg[0], fg[1], fg[2]],
    ownBg: ownBg && ownBg[3] > 0.01 ? [ownBg[0], ownBg[1], ownBg[2]] : null,
    ownBgAlpha: ownBg ? ownBg[3] : 0,
    bg: eb.rgb, bgIndeterminate: eb.indeterminate,
    fontPx: parseFloat(cs.fontSize) || 16,
    fontWeight: parseInt(cs.fontWeight, 10) || 400,
    underline: hasUnderline(cs),
    inProse: effRole === "link" ? inProse(el) : false,
    text: (el.textContent || "").trim().slice(0, 60),
  });
  dc++;
}

/* Surfaces for A3 (bright-island bound): large rendered boxes that PAINT a bg —
 * panels/heroes/cards are frequently textless containers, so island detection cannot
 * ride on text nodes. Emit any box with area ≥ 20000px² carrying an ≥90%-opaque
 * background (own or composited), with its effective bg + indeterminate flag. */
const surfaces = [];
let sc = 0;
const SURF_SEL = "div,section,header,footer,main,aside,nav,form,article,ul,ol,table,figure,button,input,textarea,select,label,li,td,p,h1,h2,h3";
const sall = document.body ? document.body.querySelectorAll(SURF_SEL) : [];
for (const el of sall) {
  const r = el.getBoundingClientRect();
  const vw = Math.min(W, r.right) - Math.max(0, r.left);
  const vh = Math.min(H, r.bottom) - Math.max(0, r.top);
  if (vw < 60 || vh < 30) continue;
  const area = Math.round(vw * vh);
  if (area < 20000) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
  const ownBg = parseColor(cs.backgroundColor);
  const hasImg = cs.backgroundImage && cs.backgroundImage !== "none";
  // only a box that itself paints a near-opaque surface (or an image) is an island
  // candidate; transparent wrappers are skipped (their child paints the surface).
  if (!hasImg && !(ownBg && ownBg[3] >= 0.9)) continue;
  el.setAttribute("data-gjoa-dcs", sc);
  surfaces.push({
    sc, tag: el.tagName,
    x: Math.round(Math.max(0, r.left)), y: Math.round(Math.max(0, r.top)),
    w: Math.round(vw), h: Math.round(vh), area,
    bg: ownBg && ownBg[3] >= 0.9 ? [ownBg[0], ownBg[1], ownBg[2]] : null,
    bgIndeterminate: hasImg,
    text: (el.textContent || "").trim().slice(0, 40),
  });
  sc++;
}

// replaced-content rects (the Channel-B seam): img/video/canvas geometry, viewport-clipped.
const replaced = [];
const rall = document.body ? document.body.querySelectorAll("img,video,canvas,picture,svg[role=img],object,embed") : [];
for (const el of rall) {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.top >= H || r.left >= W || r.bottom <= 0 || r.right <= 0) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
  replaced.push({
    x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
    w: Math.round(Math.min(W, r.right) - Math.max(0, r.left)),
    h: Math.round(Math.min(H, r.bottom) - Math.max(0, r.top)),
    tag: el.tagName.toLowerCase(),
  });
}

return {
  w: W, h: H, dpr, inverted,
  rootDark, rootBgL: Math.round(rootBgL), colorSchemeDark, normalizedSignal,
  rootBg: [Math.round(rootBgRendered[0]), Math.round(rootBgRendered[1]), Math.round(rootBgRendered[2])],
  els: out, surfaces, replaced,
};
