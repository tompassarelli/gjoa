/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Content half of the gjoa per-site dark-mode HYBRID actor (top documents only).
//
// In hybrid mode the engine (gjoa.darkmode.hybrid.default-invert) classifies the
// document pre-paint: a themeless page is flipped to inverted (dark) before first
// paint, a page that authored its own dark theme is left native — so there is no
// flash-of-light. This actor does two things on top of that:
//
//   document-start (DOMWindowCreated): ask the parent for an EXPLICIT curated
//     decision (fix registry / user per-site pref) and apply its override + css
//     + inject immediately, so curated sites (e.g. YouTube html[dark]) are
//     correct from frame 1.
//   post-paint (DOMContentLoaded): for sites with no explicit decision, a
//     best-effort refiner — it samples the body/root background (probing the live
//     inversion state to read it the right way round) and retracts the engine's
//     invert for a site that turned out dark via LATE JS/CSS theming, which the
//     engine's pre-paint root check ran too early to see.

export class GjoaDarkmodeChild extends JSWindowActorChild {
  constructor() {
    super();
    this._sheetUri = null;
    this._explicitApplied = false;
    this._explicitPromise = null;
    // Async pass-2 image-analysis state (gjoa.darkmode.image-analysis.enabled,
    // default OFF). Per-src verdict cache so repeats are free, the injected
    // <style> id, and a debounce handle for the optional one re-run.
    this._imgVerdictCache = new Map();
    // C5 dark-logo lift: per-src verdict cache (null = tainted/failed, skip).
    this._logoVerdictCache = new Map();
    this._imgStyleEl = null;
    this._dimSheet = null;
    this._imgPassScheduled = false;
    this._imgRerunTimer = null;
    // One delayed re-measure for heavy SPAs (YouTube) that are still painting a
    // loading skeleton at the first refine — only UPGRADES to forced-dark, never
    // retracts, so it can't oscillate an already-correct page.
    this._reRefined = false;
    // Curated `ignoreImageAnalysis` from the explicit decision: `true` skips the
    // pass-2 image rasterizer for the whole document; an array of selectors skips
    // matching elements. Set from Darkmode:GetInject in #applyExplicit; read in
    // #collectImageTargets. Default false = analyze everything.
    this._ignoreImageAnalysis = false;
  }

  async handleEvent(event) {
    if (this.browsingContext !== this.browsingContext.top) {
      return; // subframes inherit the top document's decision (bc->Top())
    }
    // Master gate: when dark mode is fully disabled the actor does NOTHING — no
    // per-page colorInversionOverride write, no curated-override IPC, no refiner.
    // (It used to run on every page regardless: wasted work when the feature is
    // off, and the unconditional BC write detached automation's content handle.)
    if (!Services.prefs.getBoolPref("gjoa.darkmode.enabled", true)) {
      return;
    }
    if (event.type === "DOMWindowCreated") {
      // gjoa's OWN chrome UI pages (about:gjoa / about:knobs / about:sovereignty and
      // the gjoa new-tab) are authored dark already. NEVER run them through the
      // web-content inverter, in ANY mode: mark them 'inactive' synchronously at
      // document-start. The engine reads this per-document override BEFORE the global
      // gjoa.darkmode.invert.enabled flag, so it excludes them even in 'uniform' mode
      // (where an already-dark page would otherwise be dark->light inverted — the
      // washed-out "looks like light mode" settings page).
      const gjoaUiURL = (this.document && this.document.documentURI) || "";
      if (/^(about:(gjoa|knobs|sovereignty|newtab|home)\b|chrome:\/\/gjoa)/.test(gjoaUiURL)) {
        try {
          this.browsingContext.colorInversionOverride = "inactive";
        } catch (e) {}
        return;
      }
      // OVERRIDE / FORCE mode — the COVERAGE GUARANTEE. Mark EVERY page 'active'
      // (force-invert) synchronously at document-start, EXCEPT the user's exclude
      // lists. The engine reads this per-document override BEFORE its color-scheme
      // detection, so a site that declares color-scheme (GitHub, logged-in YouTube)
      // — which the engine would otherwise skip and leave LIGHT — is forced dark.
      // No site stays light. Setting _explicitApplied stops the post-load refiner
      // from re-measuring and retracting (the contrast normalizer still runs).
      if (Services.prefs.getBoolPref("gjoa.darkmode.force", false)) {
        let host = "";
        try { host = this.document.location.hostname || ""; } catch (e) {}
        const excluded = !!host && (this.#hostInPref(host, "gjoa.darkmode.user.off") ||
                                    this.#hostInPref(host, "gjoa.darkmode.user.force-native"));
        try {
          this.browsingContext.colorInversionOverride = excluded ? "inactive" : "active";
        } catch (e) {}
        this._explicitApplied = true;
        return;
      }
      // Reset any override INHERITED from the previous same-tab page so this
      // fresh document starts from the engine's pre-paint default, then apply
      // the curated/user decision (if any) at document-start. Store the promise
      // SYNCHRONOUSLY so a DOMContentLoaded that fires before the IPC round-trip
      // resolves can await it (else the refiner races the curated decision).
      try {
        this.browsingContext.colorInversionOverride = "none";
      } catch (e) {}
      // Sync, pre-layout: apply the explicit override (curated registry mirror +
      // user per-site prefs) BEFORE PresShell::Initialize reads it, so an
      // attribute-gated curated site (YouTube) never transiently flips. The
      // css/inject still come via the async #applyExplicit.
      this.#syncExplicitOverride();
      this._explicitPromise = this.#applyExplicit();
      await this._explicitPromise;
      return;
    }
    if (event.type !== "DOMContentLoaded") {
      return;
    }
    // Serialize against the document-start curated decision before deciding the
    // refiner runs at all — otherwise both could write colorInversionOverride.
    if (this._explicitPromise) {
      try {
        await this._explicitPromise;
      } catch (e) {}
    }
    if (this._explicitApplied) {
      // A curated fix / user pref already decided the inversion at document-start —
      // the refiner is skipped, but the contrast normalization backstop still runs.
      this.#maybeNormalizeContrast(this.contentWindow, this.document);
      return;
    }
    const win = this.contentWindow;
    if (!win) {
      return;
    }
    // Refine one cascade behind: read the resolved background after two frames
    // so any late page theming has applied, then ask the parent to decide.
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => this.#measureAndRefine())
    );
  }

  async #applyExplicit() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) {
      return;
    }
    const url = doc.documentURI || "";
    if (!/^https?:/.test(url)) {
      return;
    }
    let resp;
    try {
      resp = await this.sendQuery("Darkmode:GetInject", {});
    } catch (e) {
      return;
    }
    if (!resp || !resp.explicit) {
      return; // no curated fix / user pref — engine default-invert + auto decide
    }
    this._explicitApplied = true;
    // Curated `ignoreImageAnalysis` decision: record it before the image pass is
    // scheduled below so #collectImageTargets can skip the whole document (true)
    // or the listed selectors (array). `false`/undefined = analyze everything.
    this._ignoreImageAnalysis = resp.ignoreImageAnalysis ?? false;
    // Apply the curated decision at document-start, before first paint: the
    // inject scriptlet (page main world), the curated USER_SHEET css, and the
    // inversion override — together, so the site is correct from frame 1.
    if (resp.inject) {
      this.#runInject(win, resp.inject);
    }
    if (resp.css) {
      this.#injectSheet(win, resp.css);
    }
    if (resp.override && resp.override !== "none") {
      try {
        this.browsingContext.colorInversionOverride = resp.override;
      } catch (e) {}
    }
    // Pass-2 polish (pref-gated, default off): a curated site may force-invert,
    // in which case the image pass should refine its backdrops too. #maybeRun is
    // a no-op unless the pref is on AND the engine is inverting this document.
    this.#maybeRunImagePass(win, doc);
  }

  // Synchronous, pre-layout explicit-override decision (no IPC). Mirrors the
  // parent's #explicit precedence (curated registry > user per-site prefs) but
  // reads everything from prefs the parent keeps in sync, so the override lands
  // BEFORE PresShell::Initialize. Gated on the engine's default-invert being on
  // (otherwise no pre-paint flip exists to pre-empt).
  #syncExplicitOverride() {
    try {
      if (
        !Services.prefs.getBoolPref("gjoa.darkmode.hybrid.default-invert", false)
      ) {
        return;
      }
      const url = this.document?.documentURI || "";
      if (!/^https?:/.test(url)) {
        return;
      }
      let host = "";
      try {
        host = Services.io.newURI(url).host.toLowerCase();
      } catch (e) {}
      if (!host) {
        return;
      }
      const override = this.#explicitOverrideForHost(host);
      if (override && override !== "none") {
        this.browsingContext.colorInversionOverride = override;
      }
    } catch (e) {}
  }

  #explicitOverrideForHost(host) {
    // (1) curated fix registry mirror (host -> override JSON).
    try {
      const raw = Services.prefs.getStringPref("gjoa.darkmode.fix-overrides", "");
      if (raw) {
        const map = JSON.parse(raw);
        let h = host;
        let v = map[h];
        let i;
        while (v === undefined && (i = h.indexOf(".")) !== -1) {
          h = h.slice(i + 1);
          v = map[h];
        }
        if (v) {
          return v;
        }
      }
    } catch (e) {}
    // (2) user per-site prefs (same precedence/behavior as the parent).
    if (this.#hostInPref(host, "gjoa.darkmode.user.off")) {
      return "inactive";
    }
    if (this.#hostInPref(host, "gjoa.darkmode.user.force-invert")) {
      return "active";
    }
    if (this.#hostInPref(host, "gjoa.darkmode.user.force-native")) {
      return "inactive";
    }
    return null;
  }

  #hostInPref(host, pref) {
    let raw = "";
    try {
      raw = Services.prefs.getStringPref(pref, "");
    } catch (e) {}
    return raw
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(Boolean)
      .some(h => host === h || host.endsWith("." + h));
  }

  // Run a per-site scriptlet in the page's MAIN world at document-start via a
  // privileged Cu.Sandbox over the content window — NOT a <script> element,
  // which the page CSP blocks (YouTube blocks inline scripts). sandboxPrototype
  // = win + wantXrays = false so the scriptlet's writes (html[dark]) land on the
  // page (same channel discipline as GjoaCosmeticChild.injectScriptlets).
  //
  // SECURITY INVARIANT (F7): with sandboxPrototype=win + wantXrays=false the
  // scriptlet reads the page's RAW globals (w.JSON, w.Object, w.Element), so a
  // hostile page can pre-plant getters/Proxies to observe or defeat it. This is
  // the inherent uBO-style residual and is NOT an escalation — everything here
  // runs with the CONTENT principal. The HARD rule: injected scriptlet code must
  // NEVER be handed any privileged value (chrome object, Services, Cu/Cc/Ci, the
  // actor's IPC handle) — the page can intercept every property access in this
  // sandbox, so a leaked privileged ref would cross the content/chrome boundary.
  // Only opaque code strings are evaluated here; never add chrome-side bindings
  // onto the sandbox.
  #runInject(win, code) {
    try {
      const sandbox = Cu.Sandbox(win, {
        sandboxName: "gjoa-darkmode-inject",
        sandboxPrototype: win,
        wantXrays: false,
      });
      // Defensive intrinsic capture (F7): snapshot the page's native intrinsics
      // ONCE at injection time so a scriptlet that closes over `__gjoaNative.*`
      // reads the reference captured here rather than re-deref'ing the bare
      // global, which a later page turn could swap. These are the page's own
      // content-principal globals handed straight through (the sandbox already
      // shares win's prototype) — NOT cloned, and never a chrome value. This
      // narrows, does not close, the residual (a trap planted before
      // document-start is still observed).
      try {
        sandbox.__gjoaNative = {
          JSON: win.JSON,
          Object: win.Object,
          Element: win.Element,
        };
      } catch (e) {}
      Cu.evalInSandbox(code, sandbox);
    } catch (e) {}
  }

  async #measureAndRefine() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc || !win || !doc.documentElement) {
      return;
    }
    const url = doc.documentURI || "";
    if (!/^https?:/.test(url)) {
      return;
    }
    this.#forceOpaqueRoot(win, doc);
    // Tier-1 "did we get dark?" is decided by the PARENT from a drawSnapshot of the
    // real painted pixels (the scorer's coverage), because getComputedStyle(body) is
    // fooled by system Canvas colors under color-scheme:dark (reports dark while the
    // page paints white). Pass the viewport for the snapshot; #pageIsDark goes along
    // only as the parent's fallback when the snapshot is unavailable.
    // engineInverting tells the parent WHOSE light it would be measuring: a light
    // snapshot while the engine inverts this doc means the AUTHORED page is dark —
    // the engine double-inverted a native dark theme back to light (the C3
    // gray-wash: redis/kubernetes/washingtonpost at mark 1) — NOT that the site is
    // light. The parent answers "probe-retract" and #probeRetract disambiguates by
    // re-measuring with the inversion retracted.
    const hasNativeDark = this.#pageIsDark(win, doc);
    const engineInverting = this.#engineInvertingNow(win, doc);
    const W = Math.min(win.innerWidth | 0, 1600);
    const H = Math.min(win.innerHeight | 0, 1200);
    let resp;
    try {
      resp = await this.sendQuery("Darkmode:Decide", {
        w: W,
        h: H,
        hasNativeDark,
        engineInverting,
      });
    } catch (e) {
      return;
    }
    if (!resp) {
      return;
    }
    if (resp.override === "probe-retract") {
      resp = await this.#probeRetract(win, doc, W, H);
    }
    if (!resp) {
      return;
    }
    if (resp.css) {
      this.#injectSheet(win, resp.css);
    }
    if (resp.override) {
      try {
        this.browsingContext.colorInversionOverride = resp.override;
      } catch (e) {}
    }
    if (resp.override === "inactive") {
      // The probe confirmed a native dark theme: the engine's inversion is retracted
      // for good, so the actor sheets authored FOR the inverted state are now wrong —
      // the root-opaque white bg would render as a genuine white background, and
      // panel/media rules would restyle a page that needs nothing. Remove them.
      this.#removeInversionSheets();
    }
    // When this doc ends up inverted, dim its large bright media (replaced <img>/
    // <video> heroes the engine exempts for fidelity but which keep a page reading
    // light — e.g. amazon's promo banner).
    if (resp.override === "active") {
      // #forceOpaqueRoot ran at the top BEFORE this override was set, so on a page the
      // engine force-inverts HERE (not pre-inverted by tier0) its probe saw a still-light
      // page and skipped — leaving a transparent html/body that bleeds (walmart/figma read
      // washed-out). Re-run after the override repaints so the opaque dark root is laid.
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => this.#forceOpaqueRoot(win, doc)));
    }
    // Dim large bright media + darken light panels on ANY inverted doc (each self-gates on
    // real inversion) — the engine's own default-invert leaves resp.override empty, so these
    // can't hang off "active". Before, #dimLargeMedia only ran on force-inverted pages, so an
    // engine-default-inverted page (microsoft) kept its bright bg-image hero at full light.
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => {
        this.#dimLargeMedia(win, doc);
        this.#darkenLightPanels(win, doc);
        this.#liftDarkLogos(win, doc);
      }));
    // Pass-2 polish (pref-gated, default off): the refiner has settled the
    // inversion state, so the image pass can now read it the right way round.
    this.#maybeRunImagePass(win, doc);
    // Pass-3 (pref-gated): backdrop-aware APCA contrast normalization. Runs after
    // the inversion state is settled so we measure + correct the FINAL colors.
    this.#maybeNormalizeContrast(win, doc);
    // SPA backstop: a heavy SPA (YouTube) may still be painting its loading skeleton
    // at this first refine, so the measurement read the wrong state. Re-measure ONCE
    // after a delay to catch the settled page — but skip if a decision already
    // LANDED: "active" (forced dark — only UPGRADE a still-light page, never
    // oscillate) or "inactive" (probe-confirmed native dark — a re-measure would
    // read the dark paint, answer "none", and hand the doc back to the engine's
    // durable default-invert, re-creating the double-invert wash we just retracted).
    if (!this._reRefined) {
      this._reRefined = true;
      win.setTimeout(() => {
        try {
          const ov = this.browsingContext.colorInversionOverride;
          if (ov === "active" || ov === "inactive") {
            return;
          }
          this.#measureAndRefine();
        } catch (e) {}
      }, 2500);
    }
  }

  // Is the engine luminance-inverting THIS document right now? A black probe's
  // computed color renders LIGHT under inversion. Robust to both computed-color
  // serializations (oklch L in 0..1 under the engine's OKLCH band; rgb 0..255) —
  // unlike #inversionActive's strict rgb string equality, which the oklch
  // serialization silently fails. Same dual-format read as #forceOpaqueRoot.
  #engineInvertingNow(win, doc) {
    try {
      if (!doc.body) {
        return false;
      }
      const pr = doc.createElement("span");
      pr.style.cssText = "color:#000;position:fixed;left:-9999px;top:0";
      doc.body.appendChild(pr);
      const cs = win.getComputedStyle(pr).color;
      const c = (cs.match(/[\d.]+/g) || []).map(Number);
      pr.remove();
      return /okl|lab|lch/i.test(cs)
        ? c.length >= 1 && c[0] > 0.5
        : c.length >= 3 && c[0] + c[1] + c[2] > 300;
    } catch (e) {
      return false;
    }
  }

  // Disambiguate "painted light under inversion": retract the engine's inversion
  // ("inactive"), let the re-cascade repaint, and ask the parent to re-measure the
  // now-AUTHORED paint (Darkmode:Decide with probeRetract). Dark answer ⇒ keep
  // "inactive" (the site's own dark theme renders); light answer ⇒ "active" (a
  // genuinely light page — e.g. a photo-dominated median — gets the forced invert,
  // exactly the pre-probe behavior). Returns the parent's final decision, or null
  // on IPC failure (caller bails, leaving the retraction to the SPA backstop's
  // no-op guard — the next navigation starts clean).
  async #probeRetract(win, doc, W, H) {
    try {
      this.browsingContext.colorInversionOverride = "inactive";
    } catch (e) {
      return null;
    }
    // Two rAFs for the re-cascade to reach paint, plus a settle for the compositor
    // to produce the un-inverted frame drawSnapshot reads.
    await new Promise(resolve =>
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => win.setTimeout(resolve, 150))
      )
    );
    try {
      return await this.sendQuery("Darkmode:Decide", {
        w: W,
        h: H,
        probeRetract: true,
      });
    } catch (e) {
      return null;
    }
  }

  // Remove the actor's inversion-support sheets after a doc settles on its native
  // dark theme ("inactive"): each was authored assuming the engine inverts this doc
  // (root-opaque authors WHITE for the engine to invert to the dark floor), so on a
  // retracted doc they'd paint literal white / restyle a page that needs nothing.
  #removeInversionSheets() {
    for (const key of ["_rootSheet", "_panelSheet", "_dimSheet", "_logoSheet"]) {
      try {
        this[key]?.remove();
      } catch (e) {}
      this[key] = null;
    }
    // Sheets are not the whole story: the panel pass authors INLINE background-colors (for the
    // engine to re-invert), which are NOT in any sheet. Once the inversion is retracted they'd
    // render as literal light. Revert every inline authoring + drop the marker attributes so a
    // settled-inactive doc carries none of our inverted-state paint.
    this.#revertInlinePaint();
  }

  // Undo every inline style + marker the inverted-state passes authored. Called when a doc
  // settles INACTIVE (native dark theme, engine inversion retracted): #darkenLightPanels wrote
  // inline background-colors authored to be re-inverted by the engine; with inversion gone they
  // paint literal light (the owner-reported YouTube player-control pills + Volume tooltip). Restore
  // each element's prior inline value (or remove ours), and clear the dim/logo marker attributes
  // whose sheets are already gone. Resets the pass state so a later re-invert re-runs clean.
  #revertInlinePaint() {
    for (const rec of this._panelInline || []) {
      try {
        if (!rec.el || !rec.el.isConnected) {
          continue;
        }
        if (rec.prev) {
          rec.el.style.setProperty("background-color", rec.prev, rec.prio || "");
        } else {
          rec.el.style.removeProperty("background-color");
        }
      } catch (e) {}
    }
    this._panelInline = [];
    this._panelN = 0;
    this._rePanel = false;
    this._reLogo = false;
    const doc = this.document;
    if (!doc) {
      return;
    }
    for (const attr of ["data-gjoa-panel", "data-gjoa-dim", "data-gjoa-logolift"]) {
      try {
        for (const el of doc.querySelectorAll(`[${attr}]`)) {
          el.removeAttribute(attr);
        }
      } catch (e) {}
    }
  }

  // Dim large bright replaced media (<img>/<video>/<canvas>) on an inverted page. The
  // engine exempts replaced media from inversion (a negative photo is worse than a bright
  // one), but a big bright hero — amazon's <img> promo banner — then dominates and the
  // page reads light. Tone large media down with a brightness filter (NOT an invert) so it
  // stays recognizable but sits in the dark page. Size-gated: icons/thumbnails are left
  // alone. pref gjoa.darkmode.media-dim.pct (0..100, default 55, 0 = off).
  #dimLargeMedia(win, doc) {
    try {
      let pct = 55;
      try {
        pct = Services.prefs.getIntPref("gjoa.darkmode.media-dim.pct", 55);
      } catch (e) {}
      if (pct <= 0 || pct >= 100 || !doc || !doc.documentElement || !doc.body) {
        return;
      }
      // Self-gate on real inversion: this now runs on ANY inverted doc (not just the
      // force-inverted "active" ones), so a genuinely-light page must never have its media
      // dimmed. A light page reads its swatches straight; only an inverted one flips both.
      if (!this.#inversionActive(win, doc)) {
        return;
      }
      const dim = pct / 100;
      const MIN_AREA = 150 * 150; // hero/banner scale; smaller = icon/thumb, skip
      const W = win.innerWidth || 0, H = win.innerHeight || 0;
      const tag = () => {
        let n = 0, all;
        try {
          all = doc.querySelectorAll("img,video,canvas,[style*='background'],div,section,a,header");
        } catch (e) {
          return 0;
        }
        let scanned = 0;
        for (const el of all) {
          if (++scanned > 4000) break;
          try {
            if (el.hasAttribute("data-gjoa-dim")) {
              continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width * r.height < MIN_AREA || r.top > H || r.bottom < 0 || r.left > W) {
              continue;
            }
            const tn = el.tagName;
            const isReplaced = tn === "IMG" || tn === "VIDEO" || tn === "CANVAS";
            let isMedia = isReplaced;
            if (!isMedia) {
              // a big element whose BACKGROUND is a raster image (amazon's promo banner
              // is a tan bg-image <div>) — the engine exempts it, so it stays bright.
              let bg = "";
              try { bg = win.getComputedStyle(el).backgroundImage || ""; } catch (e) {}
              isMedia = /url\(/i.test(bg);
            }
            // Replaced media (<img>/<video>/<canvas>) is a PHOTO — leave it UNTOUCHED, as
            // Dark Reader does. Dimming photos grays the whole page (target's "gray veil"
            // regression); inverting makes a negative. Only tone a large bg-image DIV the
            // engine cannot invert (a raster bg the engine exempts). ALWAYS dim (brightness
            // down), NEVER invert: a bg-image is just as likely a PHOTO (sciencedirect's hero
            // photo bled through as a colour-negative under the old wide→invert path) as a
            // graphic banner, and we can't cheaply tell them apart — dimming is the only
            // operation that is correct for both.
            if (isMedia && !isReplaced) {
              el.setAttribute("data-gjoa-dim", "dim");
              n++;
            }
          } catch (e) {}
        }
        return n;
      };
      const ensureSheet = () => {
        if (this._dimSheet && this._dimSheet.isConnected) {
          return;
        }
        const s = doc.createElement("style");
        s.id = "gjoa-darkmode-media-dim";
        s.textContent =
          `[data-gjoa-dim="dim"]{filter:brightness(${dim})!important}` +
          `[data-gjoa-dim="inv"]{filter:invert(1) hue-rotate(180deg)!important}`;
        (doc.head || doc.documentElement).appendChild(s);
        this._dimSheet = s;
      };
      if (tag()) {
        ensureSheet();
      }
      // One delayed re-tag for lazy/streamed-in heroes (not a hot observer).
      win.setTimeout(() => {
        try {
          if (tag()) {
            ensureSheet();
          }
        } catch (e) {}
      }, 1400);
    } catch (e) {}
  }

  // C5: dark logos/wordmarks invisible on a darkened page. The engine exempts
  // replaced <img> from inversion (photo fidelity), but a mostly-DARK, mostly-
  // TRANSPARENT image — a wordmark/logo drawn for a light page — then sits
  // invisible on the now-dark backdrop. Pixel-verdict such images (dark strokes +
  // real transparency + logo-scale footprint + dark painted backdrop) and flip
  // them with invert(1) hue-rotate(180deg), Dark Reader's dark-logo treatment:
  // dark strokes go light, hue is roughly kept for colored marks. Photos never
  // qualify (opaque), light logos never qualify (light pixels), icons cost one
  // 24x24 rasterize each (capped). Cross-origin images without CORS taint the
  // canvas and are skipped (verdict null, cached).
  #liftDarkLogos(win, doc) {
    try {
      // Gate on the oklch-robust probe: #inversionActive's strict rgb string
      // equality is silently FALSE under the engine's oklch serialization, so
      // gating on it would disable this pass on exactly the inverted docs it
      // exists for.
      if (!doc || !doc.body || !this.#engineInvertingNow(win, doc)) {
        return;
      }
      const CAP = 40;
      const MAX_AREA = 120000; // above ~600x200 it's a hero/banner, not a mark
      const MIN_AREA = 64;
      const parse = s => GjoaDarkmodeChild.parseComputedColor(s);
      const lumOf = rgb => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      // Effective PAINTED backdrop of an element: nearest ancestor with a
      // visible (alpha >= .5) computed background-color. Computed == painted
      // here — the engine inverts at style resolution, so no re-read is needed.
      const alphaOf = c => {
        // "rgba(r, g, b, a)" -> 4th number; "oklch(L C H / a)" -> after the
        // slash; plain rgb()/oklch() are opaque.
        if (/^rgba/i.test(c)) {
          const mm = c.match(/[\d.]+/g);
          return mm && mm.length >= 4 ? +mm[3] : 1;
        }
        if (c.includes("/")) {
          const mm = c.match(/\/\s*([\d.]+)/);
          return mm ? +mm[1] : 1;
        }
        return 1;
      };
      const backdropDark = el => {
        let e = el.parentElement;
        while (e) {
          let c = "";
          try { c = win.getComputedStyle(e).backgroundColor || ""; } catch (e2) { return false; }
          if (c && c !== "transparent" && alphaOf(c) >= 0.5) {
            const rgb = parse(c);
            if (rgb) {
              return lumOf(rgb) < 0.35;
            }
          }
          e = e.parentElement;
        }
        return false;
      };
      // Pixel classification; THROWS on a tainted canvas so the caller can
      // retry with a CORS re-fetch. Callers must ensure the image is decoded.
      const analyze = img => {
        const cv = doc.createElement("canvas");
        cv.width = 24; cv.height = 24;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data; // throws if tainted
        let trans = 0, dark = 0, light = 0, opaque = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 13) { trans++; continue; }
          opaque++;
          const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          if (l < 0.4) dark++;
          else if (l > 0.7) light++;
        }
        const total = 576;
        return opaque > 0 && trans / total >= 0.1 &&
               dark / opaque >= 0.6 && light / opaque < 0.2;
      };
      const verdict = async img => {
        const key = img.currentSrc || img.src || "";
        if (!key) {
          return false;
        }
        if (this._logoVerdictCache.has(key)) {
          return this._logoVerdictCache.get(key);
        }
        if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
          // Still loading (lazy partner rows). Do NOT cache — a later pass
          // (1600 ms / image-load-triggered) must be able to re-judge it;
          // caching false here permanently blinded the re-passes.
          return false;
        }
        let v = null; // null = no analysis ran; never cached
        try {
          v = analyze(img); // same-origin fast path
        } catch (e) {
          // Tainted: a page <img> is fetched no-cors, so even an ACAO-friendly
          // CDN taints the canvas. Re-fetch in CORS mode (hits the cache when
          // the server allows it) and retry; hosts without ACAO stay skipped.
          let im = null;
          try {
            im = new win.Image();
            im.crossOrigin = "anonymous";
            im.src = key;
            await Promise.race([
              im.decode(),
              new Promise((_, rj) => win.setTimeout(rj, 1500)),
            ]);
            v = analyze(im);
          } catch (e2) {
            // Decode finished but tainted/failed => definitively skip (cache);
            // timed out mid-load => transient, leave uncached for a re-pass.
            v = im && im.complete ? false : null;
          }
        }
        if (v !== null) {
          this._logoVerdictCache.set(key, v);
        }
        return !!v;
      };
      const apply = async () => {
        let scanned = 0, tagged = 0;
        for (const img of doc.querySelectorAll("img")) {
          if (++scanned > 400 || tagged > CAP) break;
          try {
            if (img.hasAttribute("data-gjoa-logolift")) continue;
            const r = img.getBoundingClientRect();
            const area = r.width * r.height;
            if (area < MIN_AREA || area > MAX_AREA) continue;
            if (r.bottom < 0 || r.top > (win.innerHeight || 0) * 3) continue;
            if (!backdropDark(img)) continue;
            if (await verdict(img)) {
              img.setAttribute("data-gjoa-logolift", "1");
              tagged++;
            }
          } catch (e) {}
        }
        if (tagged && (!this._logoSheet || !this._logoSheet.isConnected)) {
          const s = doc.createElement("style");
          s.id = "gjoa-darkmode-logo-lift";
          s.textContent =
            '[data-gjoa-logolift="1"]{filter:invert(1) hue-rotate(180deg)!important}';
          (doc.head || doc.documentElement).appendChild(s);
          this._logoSheet = s;
        }
      };
      apply().catch(() => {});
      if (!this._reLogo) {
        this._reLogo = true;
        // Lazy-loaded marks (partner rows) stream in late AND are too small to
        // trip the large-image load hook — bounded staggered re-passes instead
        // (verdicts are cached, so re-passes only pay for new images).
        for (const delay of [1600, 4500]) {
          win.setTimeout(() => {
            try { apply().catch(() => {}); } catch (e) {}
          }, delay);
        }
      }
    } catch (e) {}
  }

  // The uniform luminance inversion leaves MID-TONE backgrounds mid-tone (a 0.5 grey
  // inverts to ~0.55), so large panels/headers/cards read as light blocks on the dark page
  // (target's salmon header, walmart's light-blue tiles). Force big opaque mid/light-bg
  // blocks down to the dark floor, KEEPING hue/chroma (brand: a salmon header -> dark red,
  // not neutral black). One delayed re-pass catches lazy/late panels.
  #darkenLightPanels(win, doc) {
    try {
      if (!doc.body) {
        return;
      }
      // Parse the L (lightness / relative-luminance proxy) out of a computed color,
      // whether Gecko serialized it as oklch (L in 0..1) or rgb (0..255).
      const lumOf = str => {
        if (/okl|lab|lch/i.test(str)) {
          const m = str.match(/[\d.]+/g);
          return m && m.length ? parseFloat(m[0]) : null;
        }
        const m = str.match(/[\d.]+/g);
        if (!m || m.length < 3) {
          return null;
        }
        return (0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2]) / 255;
      };
      // Is the engine luminance-inverting THIS document right now? A black probe renders LIGHT under
      // inversion. Recomputed per apply() pass so a staggered re-scan sees the CURRENT state after a
      // probe-retract settles (an SPA can flip inverting → native-dark mid-flight).
      const engineInverting = () => {
        const pr = doc.createElement("span");
        pr.style.cssText = "color:#000;position:fixed;left:-9999px;top:0";
        doc.body.appendChild(pr);
        const cstr = win.getComputedStyle(pr).color;
        const pc = (cstr.match(/[\d.]+/g) || []).map(Number);
        pr.remove();
        return /okl|lab|lch/i.test(cstr) ? pc[0] > 0.5 : pc[0] + pc[1] + pc[2] > 300;
      };
      // Alpha out of a computed bg-color, both serializations: "oklch(L C H / a)" and "rgba(...)".
      const bgAlpha = str => {
        const mm = str.match(/\/\s*([\d.]+)\s*\)/);
        if (mm) {
          return parseFloat(mm[1]);
        }
        const rr = str.match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)/i);
        return rr ? parseFloat(rr[1]) : 1;
      };
      // Is the element's nearest PAINTED backdrop already dark? On an inverted page computed ==
      // painted, so a dark ancestor bg means the surroundings render dark — a light island inside
      // it (a segmented-control track, a pill strip) is residue worth darkening even below the
      // large-panel size gate.
      const backdropDark = el => {
        let e = el.parentElement, hops = 0;
        while (e && hops++ < 12) {
          let c = "";
          try {
            c = win.getComputedStyle(e).backgroundColor || "";
          } catch (e2) {
            return false;
          }
          if (c && c !== "transparent" && bgAlpha(c) >= 0.5) {
            const l = lumOf(c);
            if (l !== null) {
              return l < 0.35;
            }
          }
          e = e.parentElement;
        }
        return false;
      };
      const apply = () => {
        const inv = engineInverting();
        // A7 native-dark passthrough. When the engine is NOT inverting this doc (its own dark theme,
        // or a retracted probe), gjoa authors NOTHING — rendered ≡ authored. First SELF-HEAL: if a
        // previously-tagged panel now carries a LIGHT inline bg, it was authored via the involution
        // during a transient inverting window that has since settled (an SPA flipping to native-dark)
        // and now paints literal light — the owner's YouTube control pills. Revert + untag it. THEN
        // bail without authoring anything new: the panel darkener fires ONLY on an engine-INVERTED
        // page (the A8/B1/B2 residue class), never a native-dark one (A7).
        if (!inv && this._panelInline && this._panelInline.length) {
          const keep = [];
          for (const rec of this._panelInline) {
            let healed = false;
            try {
              const el = rec.el;
              if (el && el.isConnected) {
                const cur = win.getComputedStyle(el).backgroundColor;
                const cl = lumOf(cur);
                if (cl !== null && cl > 0.4) {
                  if (rec.prev) {
                    el.style.setProperty("background-color", rec.prev, rec.prio || "");
                  } else {
                    el.style.removeProperty("background-color");
                  }
                  el.removeAttribute("data-gjoa-panel");
                  healed = true;
                }
              }
            } catch (e) {}
            if (!healed && rec.el && rec.el.isConnected) {
              keep.push(rec);
            }
          }
          this._panelInline = keep;
          this._panelN = doc.querySelectorAll("[data-gjoa-panel]").length;
        }
        if (!inv) {
          return; // A7: native-dark / retracted — author nothing.
        }
        let n = this._panelN | 0;
        let scanned = 0;
        const SEL =
          "div,section,header,nav,main,aside,article,form,ul,input,select,textarea";
        for (const el of doc.body.querySelectorAll(SEL)) {
          if (++scanned > 4000 || n - (this._panelN | 0) > 120) {
            break;
          }
          if (el.hasAttribute("data-gjoa-panel")) {
            continue;
          }
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > 3000) {
            continue;
          }
          const tn = el.tagName;
          const isControl = tn === "INPUT" || tn === "SELECT" || tn === "TEXTAREA";
          const area = r.width * r.height;
          // Large surfaces darken outright. Form controls (search fields, selects) are chrome
          // that must match the dark UI — a far lower floor and no backdrop test (a light field
          // on an inverted page is always residue). Other SMALL light blocks (segmented-control
          // tracks, pill strips) only darken when their painted backdrop is already dark: a
          // bright island inside a dark region is residue, a light block on a light section is not.
          if (isControl) {
            if (area < 600) {
              continue;
            }
          } else if (area < 28000) {
            if (area < 6000 || !backdropDark(el)) {
              continue;
            }
          }
          let cs;
          try {
            cs = win.getComputedStyle(el);
          } catch (e) {
            continue;
          }
          const bg = cs.backgroundColor;
          // Parse the computed background in EITHER serialization. The engine serializes what it
          // INVERTS as oklch; a panel it EXEMPTS (a saturated brand band, a translucent card) keeps
          // its authored rgb()/rgba(). Matching only oklch silently skipped every exempted light
          // panel — django's mint survey band, gitlab's hero cards, paypal's cyan hero all stayed
          // bright. srcRgb != null flags the rgb path (darken by hue-preserving channel scale).
          let L, alpha, C, H, srcRgb = null;
          const mo = bg.match(
            /oklch\(([\d.]+)\s+([\d.eE+-]+)\s+([\d.a-z]+)(?:\s*\/\s*([\d.]+))?/
          );
          if (mo) {
            L = parseFloat(mo[1]);
            alpha = mo[4] !== undefined ? parseFloat(mo[4]) : 1;
            C = parseFloat(mo[2]) || 0;
            H = mo[3];
          } else {
            const mr = bg.match(
              /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/i
            );
            if (!mr) {
              continue;
            }
            const R = +mr[1], G = +mr[2], B = +mr[3];
            alpha =
              mr[4] === undefined
                ? 1
                : mr[4].endsWith("%")
                  ? parseFloat(mr[4]) / 100
                  : parseFloat(mr[4]);
            L = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
            srcRgb = [R, G, B];
          }
          // OPAQUE, MID/LIGHT-to-WHITE panels. Chroma is NOT a skip: a LIGHT brand band glares exactly
          // as a neutral one does, and DR's winning move is to DARKEN it while KEEPING hue — saturated
          // bands to a MEDIUM floor (hue stays legible), neutral ones to the dark floor. Already-dark
          // (< .40) is fine. NO near-white ceiling: on an INVERTED page any large L*>60 surface is
          // residue that B1/B2 forbid — a pure-white header/hero/article-card the engine exempted
          // (pvk.ca title band, azure hero) MUST darken, not survive as a bright island; an inverted
          // white content sheet computes DARK and never reaches here. Translucent overlays are NOT
          // handled: a see-through layer composites over what's behind it, and authoring it misfires on
          // transient glass (YouTube touch-feedback ripples). Opaque panels are the safe target.
          if (alpha < 0.6 || L < 0.40) {
            continue;
          }
          el.setAttribute("data-gjoa-panel", n);
          n++;
          // Author the dark target and, because the engine luminance-inverts what it does NOT exempt,
          // read the paint back and re-author the read-back if it flipped light (the involution:
          // authoring engine(x) paints engine(engine(x)) = x; patch 0009). An exempted panel stays
          // dark on the first write. RECORD the prior inline value FIRST: this is inline authoring, so
          // on a doc that later settles INACTIVE (native dark) it must be reverted (#revertInlinePaint)
          // or it persists as literal light paint — the YouTube player-control pills the owner reported.
          try {
            const prev = el.style.getPropertyValue("background-color");
            const prio = el.style.getPropertyPriority("background-color");
            (this._panelInline || (this._panelInline = [])).push({ el, prev, prio });
            let target;
            if (srcRgb) {
              // rgb source: scale channels to the target luminance, preserving hue. Saturated → a
              // medium floor (brand hue stays legible); neutral → the dark floor.
              const mx = Math.max(srcRgb[0], srcRgb[1], srcRgb[2]);
              const mn = Math.min(srcRgb[0], srcRgb[1], srcRgb[2]);
              const sat = mx > 0 ? (mx - mn) / mx : 0;
              const targetLum = sat > 0.15 ? 0.30 : 0.18;
              const scale = L > 0.001 ? Math.min(1, targetLum / L) : 0;
              target =
                `rgb(${Math.round(srcRgb[0] * scale)}, ${Math.round(srcRgb[1] * scale)}, ` +
                `${Math.round(srcRgb[2] * scale)})`;
            } else {
              const brand = C > 0.05;
              const targetL = brand ? 0.32 : 0.2;
              const targetC = brand ? Math.min(C, 0.11) : C;
              target = `oklch(${targetL} ${targetC} ${H})`;
            }
            el.style.setProperty("background-color", target, "important");
            const got = win.getComputedStyle(el).backgroundColor;
            const lg = lumOf(got);
            if (lg !== null && lg > 0.4) {
              el.style.setProperty("background-color", got, "important");
            }
          } catch (e) {}
        }
        this._panelN = n;
      };
      apply();
      if (!this._rePanel) {
        this._rePanel = true;
        // SPA panels stream in late; a few staggered re-scans catch them (each tags only
        // newly-appeared panels — already-tagged ones are skipped).
        for (const delay of [1500, 4000, 8000]) {
          win.setTimeout(() => {
            try {
              apply();
            } catch (e) {}
          }, delay);
        }
      }
    } catch (e) {}
  }

  // When the engine inverts THIS document, pin html/body to opaque white — the engine
  // inverts white to the dark floor, giving an opaque dark root. Closes the transparent-
  // root desktop-bleed (Wikipedia <html> = rgba(0,0,0,0)). Mirrors Dark Reader's forced
  // UA root sheet; gated on a black probe rendering light, so native-dark pages untouched.
  #forceOpaqueRoot(win, doc) {
    try {
      if (this._rootSheet && this._rootSheet.isConnected) {
        return;
      }
      if (!doc.body) {
        return;
      }
      const pr = doc.createElement("span");
      pr.style.cssText = "color:#000;position:fixed;left:-9999px;top:0";
      doc.body.appendChild(pr);
      const cs = win.getComputedStyle(pr).color;
      const c = (cs.match(/[\d.]+/g) || []).map(Number);
      // Computed color may serialize as oklch (L in 0..1) or rgb (0..255); an inverted
      // black probe renders LIGHT either way.
      const inverted = /okl|lab|lch/i.test(cs)
        ? c.length >= 1 && c[0] > 0.5
        : c.length >= 3 && c[0] + c[1] + c[2] > 300;
      pr.remove();
      if (!inverted) {
        return;
      }
      const s = doc.createElement("style");
      s.id = "gjoa-darkmode-root-opaque";
      // Root: force opaque (engine inverts white->dark floor). Native text controls:
      // give them an opaque bg the engine inverts to dark (Dark Reader tones the same
      // set) — NO !important so page-styled controls keep their own (inverted) look.
      s.textContent =
        "html,body{background-color:#fff!important}" +
        "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=image]),textarea,select{background-color:#fff}";
      (doc.head || doc.documentElement).appendChild(s);
      this._rootSheet = s;
    } catch (e) {}
  }

  // Schedule the contrast-normalization pass after the override's re-cascade paints.
  #maybeNormalizeContrast(win, doc) {
    if (!Services.prefs.getBoolPref("gjoa.darkmode.normalize.enabled", false)) {
      return;
    }
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => this.#normalizeContrast(win, doc))
    );
    // C1 fg/bg desync backstop: the first retone samples the composited backdrop the
    // instant DOMContentLoaded settles, but a hero whose EFFECTIVE background is a late
    // bg-image / gradient (microsoft "Hi there", paypal) has not painted yet — so the
    // parent's drawSnapshot reads the element's (dark, inverted) bg-COLOR, judges the
    // light text legible, and skips it. Once the light image paints, the text is
    // light-on-light. Re-sample on a staggered schedule so at least one pass reads the
    // FINAL painted backdrop and couples the fg to it (light bg ⇒ dark fg). Staggered,
    // bounded (not a hot observer); each pass is idempotent — already-legible text yields
    // no corrective and is left as-is.
    if (!this._reNormalized) {
      this._reNormalized = true;
      for (const delay of [1500, 3500, 8000]) {
        win.setTimeout(() => {
          try { this.#normalizeContrast(win, doc); } catch (e) {}
        }, delay);
      }
    }
    // The staggered re-passes LOSE THE RACE to a hero image that decodes after
    // the last one (a large exempt <img> under engine-lightened text: the 8 s
    // pass reads the dark skeleton, judges the light text legible, and the
    // light-on-light wash appears when the image paints at 10-15 s). Make the
    // trigger EVENT-DRIVEN instead of guessing at timers: any LARGE image
    // finishing load schedules one debounced re-pass, so the normalizer always
    // re-reads the FINAL painted backdrop. Bounded (≤4 extra passes) and
    // idempotent — already-legible text yields no corrective.
    if (!this._imgLoadHooked) {
      this._imgLoadHooked = true;
      this._imgLoadPasses = 0;
      const onLoad = e => {
        try {
          const t = e.target;
          if (!t || t.tagName !== "IMG" || this._imgLoadPasses >= 4) {
            return;
          }
          const r = t.getBoundingClientRect();
          if (r.width * r.height < 40000) {
            return; // thumbnails/icons can't wash a heading's backdrop
          }
          if (this._imgLoadTimer) {
            win.clearTimeout(this._imgLoadTimer);
          }
          this._imgLoadTimer = win.setTimeout(() => {
            this._imgLoadTimer = null;
            this._imgLoadPasses++;
            try {
              this.#normalizeContrast(win, doc);
              this.#liftDarkLogos(win, doc);
            } catch (e2) {}
          }, 350);
        } catch (e2) {}
      };
      // capture phase: img load events don't bubble.
      doc.addEventListener("load", onLoad, true);
    }
  }

  // Parse a COMPUTED color string to sRGB [r,g,b] (0..255), or null. Handles BOTH
  // serializations Gecko emits: legacy rgb()/rgba() AND oklch() — the engine's
  // luminance inversion (patch 0009) produces OKLCH values, so every color the
  // engine touched serializes as oklch. The old rgb-only regex read
  // "oklch(0.77 0.03 260)" as R=0.77 G=0.03 B=260 — a garbage near-black — which
  // made the APCA judge see "dark text" wherever the engine had inverted text
  // LIGHT: exactly the elements the normalizer exists to check (an exempt light
  // image backdrop under engine-lightened text was judged legible and skipped).
  static parseComputedColor(s) {
    if (!s) {
      return null;
    }
    // Achromatic components serialize as the literal keyword none —
    // "oklch(0.92 0 none)", the engine's own inverted-black output — so map
    // none -> 0 BEFORE the numeric match or the 3-component gate drops the
    // color and the caller silently skips the element.
    const m = s.replace(/\bnone\b/g, "0").match(/-?[\d.]+(?:e[+-]?\d+)?/gi);
    if (!m || m.length < 3) {
      return null;
    }
    if (/^oklch/i.test(s)) {
      const L = +m[0], C = +m[1], H = +m[2];
      // oklch -> oklab -> LMS' -> linear sRGB -> sRGB (Björn Ottosson's OKLab).
      const hr = (H * Math.PI) / 180;
      const a = C * Math.cos(hr), b = C * Math.sin(hr);
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.291485548 * b;
      const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
      const rl = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
      const gl = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
      const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
      const gam = x => {
        x = Math.max(0, Math.min(1, x));
        return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
      };
      return [gam(rl), gam(gl), gam(bl)];
    }
    if (/^rgb/i.test(s)) {
      return [+m[0], +m[1], +m[2]];
    }
    return null; // lab()/lch()/color() — not produced by this engine's paths
  }

  // Walk visible text, tag each node (data-gjoa-cn), and ask the parent — which can
  // drawSnapshot the REAL composited content — for corrective colors against each
  // element's true backdrop. Apply the returned correctives. Single pass (no re-tag).
  async #normalizeContrast(win, doc) {
    if (!doc || !doc.body) {
      return;
    }
    const _t0 = win.performance.now();   // #137: normalizer phase timing
    const parse = s => GjoaDarkmodeChild.parseComputedColor(s);
    const W = win.innerWidth,
      H = win.innerHeight;
    // Is the engine inverting THIS doc? A black probe renders light if so — which
    // tells the parent whether to pre-invert the correctives.
    let inverted = false;
    try {
      const pr = doc.createElement("span");
      pr.style.cssText = "color:#000;position:fixed;left:-9999px;top:0;";
      doc.body.appendChild(pr);
      const pc = parse(win.getComputedStyle(pr).color);
      inverted = !!(pc && 0.2126 * pc[0] + 0.7152 * pc[1] + 0.0722 * pc[2] > 40);
      pr.remove();
    } catch (e) {}
    const els = [];
    let cn = 0;
    const sel =
      "h1,h2,h3,h4,h5,h6,p,a,span,li,td,th,div,button,label,strong,em,blockquote,figcaption,dt,dd";
    for (const el of doc.body.querySelectorAll(sel)) {
      let hasText = false;
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim().length > 1) {
          hasText = true;
          break;
        }
      }
      if (!hasText) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 8 || r.top >= H || r.left >= W || r.bottom <= 0 || r.right <= 0) {
        continue;
      }
      const cs = win.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) {
        continue;
      }
      const fg = parse(cs.color);
      if (!fg) {
        continue;
      }
      el.setAttribute("data-gjoa-cn", cn);
      els.push({
        cn,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        fg,
      });
      cn++;
    }
    const _tWalk = win.performance.now();   // #137: end of DOM walk
    if (!els.length) {
      return;
    }
    let resp;
    try {
      resp = await this.sendQuery("Darkmode:Normalize", { w: W, h: H, inverted, els });
    } catch (e) {
      return;
    }
    const _tQuery = win.performance.now();   // #137: end of sendQuery round-trip
    const correctives = (resp && resp.correctives) || [];
    // Replicate the engine's luminance inversion (patch 0009 — an involution) so we
    // can pre-invert per element.
    const invertLum = rgb => {
      const comp = u => {
        const f = u / 255;
        return f <= 0.03928 ? f / 12.92 : Math.pow((f + 0.055) / 1.055, 2.4);
      };
      const dec = x => {
        const s = x <= 0.03928 / 12.92 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
        return Math.min(255, Math.max(0, Math.round(s * 255)));
      };
      const lr = comp(rgb[0]), lg = comp(rgb[1]), lb = comp(rgb[2]);
      const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const factor = (1 - lum + 0.05) / (lum + 0.05);
      const adj = l => dec(Math.max(0, (l + 0.05) * factor - 0.05));
      return [adj(lr), adj(lg), adj(lb)];
    };
    const close = (a, b) =>
      a && b && Math.abs(a[0] - b[0]) <= 8 && Math.abs(a[1] - b[1]) <= 8 && Math.abs(a[2] - b[2]) <= 8;
    for (const c of correctives) {
      const el = doc.querySelector(`[data-gjoa-cn="${c.cn}"]`);
      if (!el) {
        continue;
      }
      const target = parse(c.color);
      // Author the target; read what the engine actually renders. If it inverted the
      // value (rendered far from target), re-author invertLum(target) so the engine's
      // inversion lands ON the target. This is per-element, so a non-inverted light
      // card inside an inverted dark page is handled correctly.
      el.style.setProperty("color", c.color, "important");
      const rendered = parse(win.getComputedStyle(el).color);
      if (target && rendered && !close(rendered, target)) {
        const inv = invertLum(target);
        el.style.setProperty("color", `rgb(${inv[0]},${inv[1]},${inv[2]})`, "important");
      }
    }
    // Completion signal — lets a harness wait event-driven (not a fixed timer) for
    // the async normalize round-trip to finish before measuring contrast.
    try {
      const _tEnd = win.performance.now();   // #137: total + per-phase timing
      doc.documentElement.setAttribute(
        "data-gjoa-normalized",
        String(correctives.length)
      );
      doc.documentElement.setAttribute(
        "data-gjoa-normalize-ms",
        String(Math.round(_tEnd - _t0))
      );
      doc.documentElement.setAttribute(
        "data-gjoa-normalize-detail",
        `els=${els.length} walk=${Math.round(_tWalk - _t0)} query=${Math.round(_tQuery - _tWalk)} apply=${Math.round(_tEnd - _tQuery)}`
      );
      // #137: a harness-readable channel that survives the content-handle detach the
      // colorInversionOverride write causes (which makes the DOM-attr read flaky under
      // Marionette — the same wall that blocks the content-context contrast harness).
      // Pref-gated, zero overhead off. Format is tab-delimited for trivial parsing.
      if (Services.prefs.getBoolPref("gjoa.darkmode.normalize.logms", false)) {
        dump(
          `GJOA_NORMALIZE_MS\t${doc.documentURI}\tms=${Math.round(_tEnd - _t0)}` +
            `\tels=${els.length}\twalk=${Math.round(_tWalk - _t0)}` +
            `\tquery=${Math.round(_tQuery - _tWalk)}\tapply=${Math.round(_tEnd - _tQuery)}\n`
        );
      }
    } catch (e) {}
  }

  #injectSheet(win, css) {
    if (!win.windowUtils || !css) {
      return;
    }
    const utils = win.windowUtils;
    const uri = "data:text/css;charset=utf-8," + encodeURIComponent(css);
    try {
      if (this._sheetUri) {
        try {
          utils.removeSheetUsingURIString(this._sheetUri, utils.USER_SHEET);
        } catch (e) {}
      }
      utils.loadSheetUsingURIString(uri, utils.USER_SHEET);
      this._sheetUri = uri;
    } catch (e) {}
  }

  didDestroy() {
    if (this._sheetUri) {
      try {
        const utils = this.contentWindow?.windowUtils;
        utils?.removeSheetUsingURIString(this._sheetUri, utils.USER_SHEET);
      } catch (e) {}
      this._sheetUri = null;
    }
    if (this._imgRerunTimer !== null) {
      try {
        this.contentWindow?.clearTimeout(this._imgRerunTimer);
      } catch (e) {}
      this._imgRerunTimer = null;
    }
    try {
      this._imgStyleEl?.remove();
    } catch (e) {}
    this._imgStyleEl = null;
  }

  // ── Pass 2: async image-luminance analysis (pref-gated, DEFAULT OFF) ────────
  //
  // This is unverified POLISH on top of the engine-level dark scrim, which is the
  // correctness floor. When gjoa.darkmode.image-analysis.enabled is false this
  // whole subsystem is a NO-OP — the engine scrim must never be disturbed by it.
  // When on (and the engine is actually inverting this document) it ports Dark
  // Reader's image track: rasterize each visible background-image url() to a 32x32
  // canvas, classify its brightness, and refine per-image via a single injected
  // <style> (hide large light backdrops, invert small dark transparent ones,
  // replace near-solid light ones with a darkened solid). Everything is wrapped so
  // a failure never throws out of the actor or breaks the page.

  #imagePassEnabled() {
    try {
      return Services.prefs.getBoolPref(
        "gjoa.darkmode.image-analysis.enabled",
        false
      );
    } catch (e) {
      return false;
    }
  }

  // Gate + schedule. No-op unless the pref is on AND the engine is inverting this
  // document (otherwise there's nothing to refine — the page reads light-on-light
  // natively). Runs at most once per document on the idle queue; the optional
  // debounced re-run is scheduled from there, never a hot MutationObserver.
  #maybeRunImagePass(win, doc) {
    try {
      if (this._imgPassScheduled) {
        return;
      }
      if (!win || !doc || !doc.documentElement) {
        return;
      }
      if (!this.#imagePassEnabled()) {
        return; // unverified polish — off by default, engine scrim is the floor
      }
      if (!this.#inversionActive(win, doc)) {
        return; // engine isn't inverting this doc; nothing for pass-2 to refine
      }
      this._imgPassScheduled = true;
      const idle =
        typeof win.requestIdleCallback === "function"
          ? cb => win.requestIdleCallback(cb, { timeout: 2000 })
          : cb => win.setTimeout(cb, 200);
      idle(() => this.#runImagePass(win, doc));
    } catch (e) {}
  }

  #runImagePass(win, doc) {
    try {
      const targets = this.#collectImageTargets(win, doc);
      const rules = [];
      for (const t of targets) {
        let verdict = this._imgVerdictCache.get(t.src);
        if (verdict === undefined) {
          verdict = this.#analyzeImage(win, doc, t.src);
          this._imgVerdictCache.set(t.src, verdict); // null = tainted/failed/skip
        }
        if (!verdict) {
          continue;
        }
        const rule = this.#decideImageRule(win, t, verdict);
        if (rule) {
          rules.push(rule);
        }
      }
      if (rules.length) {
        this.#applyImageRules(win, doc, rules);
      }
      // OPTIONAL one debounced re-run to catch images that streamed in after the
      // initial pass (lazy-loaded heroes). NOT a per-mutation observer.
      if (this._imgRerunTimer === null) {
        this._imgRerunTimer = win.setTimeout(() => {
          this._imgRerunTimer = null;
          try {
            const more = this.#collectImageTargets(win, doc);
            const extra = [];
            for (const t of more) {
              let v = this._imgVerdictCache.get(t.src);
              if (v === undefined) {
                v = this.#analyzeImage(win, doc, t.src);
                this._imgVerdictCache.set(t.src, v);
              }
              if (!v) {
                continue;
              }
              const r = this.#decideImageRule(win, t, v);
              if (r) {
                extra.push(r);
              }
            }
            if (extra.length) {
              this.#applyImageRules(win, doc, extra);
            }
          } catch (e) {}
        }, 1500);
      }
    } catch (e) {}
  }

  // Enumerate elements whose computed background-image resolves to a url() (skip
  // gradients), that are currently visible, capped at the first ~32. Each target
  // carries the element, its resolved src, and the element's natural-ish box so
  // the decision tree can read isLarge from the rendered footprint.
  #collectImageTargets(win, doc) {
    const CAP = 32;
    const out = [];
    // Curated IGNORE IMAGE ANALYSIS: `true` opts the whole document out of the
    // rasterizer pass; an array is a selector list whose matches are skipped.
    const ignore = this._ignoreImageAnalysis;
    if (ignore === true) {
      return out;
    }
    // Join an array of selectors into one matcher string (a comma list). Invalid
    // selectors would throw at el.matches(); we validate once and drop a bad list
    // rather than break the whole pass.
    let ignoreSel = "";
    if (Array.isArray(ignore) && ignore.length) {
      ignoreSel = ignore.join(",");
      try {
        doc.querySelector(ignoreSel); // validate the combined selector once
      } catch (e) {
        ignoreSel = ""; // malformed curated list — ignore it, analyze normally
      }
    }
    let all;
    try {
      all = doc.querySelectorAll("*");
    } catch (e) {
      return out;
    }
    let scanned = 0;
    let capped = false;
    for (const el of all) {
      let bg = "";
      try {
        bg = win.getComputedStyle(el).backgroundImage || "";
      } catch (e) {
        continue;
      }
      if (!bg || bg === "none") {
        continue;
      }
      // url("...") only — gradients (linear-/radial-/conic-) are not rasterizable
      // here and the engine already inverts their color stops.
      const src = this.#firstUrl(bg);
      if (!src) {
        continue;
      }
      if (!this.#isVisible(win, el)) {
        continue;
      }
      // Per-selector IGNORE IMAGE ANALYSIS: skip elements the curated list names.
      if (ignoreSel) {
        try {
          if (el.matches(ignoreSel)) {
            continue;
          }
        } catch (e) {}
      }
      out.push({ el, src });
      if (++scanned >= CAP) {
        capped = true;
        break;
      }
    }
    if (capped) {
      try {
        Services.console.logStringMessage(
          "[gjoa darkmode] image-analysis pass capped at " +
            CAP +
            " visible background images"
        );
      } catch (e) {}
    }
    return out;
  }

  // Extract the first url() target from a computed background-image, ignoring
  // gradient layers. Returns null for gradient-only / data-less values.
  #firstUrl(bgImage) {
    const m = bgImage.match(/url\(\s*(["']?)([^"')]+)\1\s*\)/);
    if (!m) {
      return null;
    }
    const u = m[2].trim();
    if (!u || u === "none") {
      return null;
    }
    return u;
  }

  #isVisible(win, el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        return false;
      }
      const vw = win.innerWidth || 0;
      const vh = win.innerHeight || 0;
      // Intersects the viewport (loose — heroes can extend beyond it).
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
        return false;
      }
      const cs = win.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // Rasterize an image src to a 32x32 offscreen canvas and classify it with Dark
  // Reader's exact thresholds. Returns a verdict object, or null on any failure
  // (cross-origin / tainted canvas / load error) so the caller skips that image.
  // Cross-origin images taint the canvas; getImageData then throws — caught here.
  #analyzeImage(win, doc, src) {
    try {
      const img = new win.Image();
      // crossOrigin="anonymous" lets CORS-enabled hosts produce a clean canvas;
      // for non-CORS images the canvas taints and getImageData throws (caught).
      try {
        img.crossOrigin = "anonymous";
      } catch (e) {}
      img.src = src;
      // The image must already be decoded for a synchronous draw. Background
      // images visible on screen are loaded by the time the idle pass runs; if
      // not complete we skip (cached as null) rather than block on async decode.
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
        return null;
      }
      const sw = img.naturalWidth;
      const sh = img.naturalHeight;

      const MAX = 32 * 32; // MAX_ANALYSIS_PIXELS_COUNT
      const LARGE = 512 * 512; // LARGE_IMAGE_PIXELS_COUNT
      const isLarge = sw * sh > LARGE;

      const k = Math.min(1, Math.sqrt(MAX / (sw * sh)));
      const width = Math.max(1, Math.ceil(sw * k));
      const height = Math.max(1, Math.ceil(sh * k));

      const canvas = doc.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        return null;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, sw, sh, 0, 0, width, height);

      let data;
      try {
        data = ctx.getImageData(0, 0, width, height).data; // throws if tainted
      } catch (e) {
        return null; // cross-origin / tainted — skip gracefully
      }

      // Dark Reader thresholds (image.ts), verbatim.
      const TRANSPARENT_ALPHA_THRESHOLD = 0.05;
      const DARK_LIGHTNESS_THRESHOLD = 0.4;
      const LIGHT_LIGHTNESS_THRESHOLD = 0.7;
      const DARK_IMAGE_THRESHOLD = 0.7;
      const LIGHT_IMAGE_THRESHOLD = 0.7;
      const TRANSPARENT_IMAGE_THRESHOLD = 0.1;
      const SOLID_LIGHTNESS_DIFF_THRESHOLD = 0.1;

      let transparentPixelsCount = 0;
      let darkPixelsCount = 0;
      let lightPixelsCount = 0;
      let minLightness = 1;
      let maxLightness = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = 4 * (y * width + x);
          const r = data[i + 0];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          sumR += r;
          sumG += g;
          sumB += b;
          sumA += a;
          if (a / 255 < TRANSPARENT_ALPHA_THRESHOLD) {
            transparentPixelsCount++;
          } else {
            // getSRGBLightness: luma-weighted average normalized to [0,1].
            const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            if (l < DARK_LIGHTNESS_THRESHOLD) {
              darkPixelsCount++;
            }
            if (l > LIGHT_LIGHTNESS_THRESHOLD) {
              lightPixelsCount++;
            }
            if (l < minLightness) {
              minLightness = l;
            }
            if (l > maxLightness) {
              maxLightness = l;
            }
          }
        }
      }

      const totalPixelsCount = width * height;
      const opaquePixelsCount = totalPixelsCount - transparentPixelsCount || 1;

      const isSolid =
        sumA === totalPixelsCount * 255 &&
        maxLightness - minLightness < SOLID_LIGHTNESS_DIFF_THRESHOLD;
      const solidColor = isSolid
        ? {
            r: Math.round(sumR / opaquePixelsCount),
            g: Math.round(sumG / opaquePixelsCount),
            b: Math.round(sumB / opaquePixelsCount),
          }
        : null;

      return {
        isDark: darkPixelsCount / opaquePixelsCount >= DARK_IMAGE_THRESHOLD,
        isLight: lightPixelsCount / opaquePixelsCount >= LIGHT_IMAGE_THRESHOLD,
        isTransparent:
          transparentPixelsCount / totalPixelsCount >=
          TRANSPARENT_IMAGE_THRESHOLD,
        isLarge,
        width: sw,
        solidColor,
      };
    } catch (e) {
      return null;
    }
  }

  // Dark Reader's getBgImageValue tree (modify-css.ts), ORDER MATTERS. We're only
  // ever called when the engine is inverting (theme.mode === 1 equivalent), so the
  // light-mode branch is omitted. Returns { sel, decl } for the injected sheet, or
  // null to LEAVE the image (the engine scrim handles dark heroes).
  #decideImageRule(win, target, v) {
    const sel = this.#selectorFor(win, target.el);
    if (!sel) {
      return null;
    }
    // 1) large + light + opaque → HIDE the image; give the container a dark bg so
    //    the engine inversion/scrim owns the backdrop.
    if (v.isLarge && v.isLight && !v.isTransparent) {
      return {
        sel,
        decl: "background-image: none !important; background-color: #1a1a1a !important;",
      };
    }
    // 2) dark + transparent + small (width > 2) → INVERT this element's bg image.
    if (v.isDark && v.isTransparent && v.width > 2) {
      return {
        sel,
        decl: "filter: invert(1) hue-rotate(180deg) !important;",
      };
    }
    // 3) light + opaque (small) → near-solid? replace with a darkened solid color.
    //    Without a solid read, LEAVE it (we don't ship an SVG-invert filter URL in
    //    this pass; the engine scrim still covers the hero).
    if (v.isLight && !v.isTransparent) {
      if (v.solidColor) {
        const dark = this.#darkenSolid(v.solidColor);
        return {
          sel,
          decl:
            "background-image: none !important; background-color: " +
            dark +
            " !important;",
        };
      }
      return null;
    }
    // 4) otherwise (incl. dark opaque heroes) → LEAVE; engine scrim handles it.
    return null;
  }

  // Approximate Dark Reader's modifyBackgroundColor: pull a light solid toward a
  // dark equivalent by inverting lightness while keeping hue. Cheap HSL flip — the
  // exact result isn't load-bearing (the engine scrim is the floor); this just
  // avoids a bright solid block under inversion.
  #darkenSolid({ r, g, b }) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lOld = (max + min) / 2;
    // Map lightness L -> ~0.85*(1-L) so a near-white solid becomes near-black,
    // clamped to a comfortable dark band.
    const lNew = Math.max(0.08, Math.min(0.22, 0.85 * (1 - lOld)));
    const scale = lOld > 0 ? lNew / lOld : 0;
    const dr = Math.round(Math.min(255, rn * scale * 255));
    const dg = Math.round(Math.min(255, gn * scale * 255));
    const db = Math.round(Math.min(255, bn * scale * 255));
    return "rgb(" + dr + ", " + dg + ", " + db + ")";
  }

  // A stable, idempotent selector for the element. Prefer #id; else stamp a
  // data-attribute we own so re-runs target the SAME element without growing the
  // class list or colliding with page selectors.
  #selectorFor(win, el) {
    try {
      if (el.id && win.CSS && typeof win.CSS.escape === "function") {
        return "#" + win.CSS.escape(el.id);
      }
      let stamp = el.getAttribute("data-gjoa-dm-img");
      if (!stamp) {
        stamp =
          "i" + (this._imgVerdictCache.size + 1) + "-" + (Date.now() % 100000);
        el.setAttribute("data-gjoa-dm-img", stamp);
      }
      return '[data-gjoa-dm-img="' + stamp + '"]';
    } catch (e) {
      return null;
    }
  }

  // Apply the decided rules via ONE id'd <style> appended once (idempotent,
  // removable in didDestroy). Append-only across re-runs so prior verdicts stick.
  #applyImageRules(win, doc, rules) {
    try {
      if (!this._imgStyleEl || !this._imgStyleEl.isConnected) {
        const style = doc.createElement("style");
        style.id = "gjoa-darkmode-image-pass";
        style.setAttribute("type", "text/css");
        (doc.head || doc.documentElement).appendChild(style);
        this._imgStyleEl = style;
      }
      let css = this._imgStyleEl.textContent || "";
      for (const r of rules) {
        css += r.sel + " { " + r.decl + " }\n";
      }
      this._imgStyleEl.textContent = css;
    } catch (e) {}
  }

  // Coarse "is this page's AUTHORED background dark?" check for the refiner. The
  // effective bg is body, then documentElement; first OPAQUE color wins (all
  // transparent ⇒ the UA canvas shows ⇒ not dark). When the engine is currently
  // inverting this document, the measured bg is the inverted authored color, so we
  // flip the luminance (the inversion is a luminance map ~Y -> 1 - Y) to read it
  // the right way round — without this, an inverted themeless page would read dark
  // and be misclassified native-dark. This is a THRESHOLD test, not an exact
  // recovery (channel clamping makes the flip approximate near the boundary); the
  // engine's pre-paint check is the precise classifier, this only catches the
  // late-theme tail.
  #pageIsDark(win, doc) {
    const read = el => {
      try {
        return win.getComputedStyle(el).backgroundColor || "";
      } catch (e) {
        return "";
      }
    };
    let bg = "";
    for (const el of [doc.body, doc.documentElement]) {
      if (!el) {
        continue;
      }
      const c = read(el);
      // Skip only FULLY-transparent backgrounds. Gecko serializes opaque colors
      // as 3-arg `rgb(r, g, b)` and transparent as 4-arg `rgba(r, g, b, 0)`, so
      // the alpha test must require a real 4th channel — anchoring on the last
      // comma alone would match the blue channel of `rgb(0, 0, 0)` (opaque black,
      // the most common dark bg) and wrongly treat it as transparent.
      if (
        c &&
        c !== "transparent" &&
        !/^rgba?\([^,)]*,[^,)]*,[^,)]*,\s*0(?:\.0+)?\s*\)$/.test(c)
      ) {
        bg = c;
        break;
      }
    }
    if (!bg) {
      return false;
    }
    let lum = this.#luminance(bg);
    if (this.#inversionActive(win, doc)) {
      lum = 1 - lum;
    }
    return lum < 0.22;
  }

  // Detect whether the engine is luminance-inverting this document by probing
  // known swatches: under inversion white computes to black AND black to white.
  // Requiring BOTH flips avoids a false positive from a stray user-!important /
  // leftover USER_SHEET background spoofing a single swatch.
  #inversionActive(win, doc) {
    const read = bg => {
      try {
        const probe = doc.createElement("div");
        probe.style.cssText =
          "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;" +
          "background-color:" + bg;
        (doc.body || doc.documentElement).appendChild(probe);
        const c = win.getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      } catch (e) {
        return "";
      }
    };
    return (
      read("rgb(255,255,255)") === "rgb(0, 0, 0)" &&
      read("rgb(0,0,0)") === "rgb(255, 255, 255)"
    );
  }

  #luminance(rgbStr) {
    const m = rgbStr.match(/[\d.]+/g);
    if (!m || m.length < 3) {
      return 1;
    }
    const lin = c => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(+m[0]) + 0.7152 * lin(+m[1]) + 0.0722 * lin(+m[2]);
  }
}
