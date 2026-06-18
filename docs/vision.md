# gjoa

### A Firefox fork where the features the world ships as extensions are part of the engine.

---

Every browser lets you *install* dark mode. Every browser lets you *install* an ad blocker. You download a content script; it runs JavaScript in every page you visit; it injects stylesheets; it re-samples colors every frame; it watches your requests fly past and tries to cancel them. It flashes. It janks. It can be disabled, throttled, fingerprinted, or — as Chrome's Manifest V3 just proved — legislated out of existence.

gjoa does not let you install these things. gjoa **is** a browser that does them.

The difference is the difference between a costume and a body. An extension is a costume the browser wears over a feature it doesn't have. gjoa moves the feature one layer down — into the cascade, into the network classifier, into the engine — where it is computed once, cached, un-removable, and *free at runtime*. This document is the proof that we already did it twice, the argument that the same move is a pattern and not a pair of one-offs, and the roadmap for every place we turn that crank next.

It is built on Firefox 152 — a real Gecko source fork, not a theme, not a userscript pack, not a Chromium reskin. Five patches. We'll show you all five.

---

## What already ships

Two features. The same move, made twice. Read these closely, because everything else in this document is this move applied again — and if you don't believe these, you shouldn't believe the rest.

### Existence proof #1 — Dark mode that *cannot* flash, because the flash is structurally impossible

Dark Reader flashes white on every navigation. This is documented, upstream-acknowledged, and **unfixable** — not because the maintainers are careless, but because of *where they live in the stack*. The page paints before their content script runs. You cannot win a race against a thing that already happened.

gjoa's dark mode lives where the race is over before it starts.

- **It inverts at computed-value time inside Servo, not at paint.** `invert_color_luminance()` is hooked at the tail of `Color::to_computed_color` (`engine/servo/components/style/values/specified/color.rs`), after the cascade resolves the specified color. The inverted value lands in `ComputedValues` and is **cached**. A compositor `filter: invert()` re-runs every frame, forever; this runs once per restyle and is then free. That is what "engine-native" actually buys — not depth for its own sake, but *zero per-frame cost*.

- **The math is a WCAG relative-luminance flip, not an RGB complement.** `invert_color_luminance` linearizes each channel (sRGB→linear), computes `Y = 0.2126·R + 0.7152·G + 0.0722·B`, targets `1 − Y`, and rescales all three channels by the WCAG contrast-ratio factor `(target+0.05)/(lum+0.05)`. It is a byte-for-byte port of Firefox's own `gfx/src/RelativeLuminanceUtils.h::Adjust`. Hue, saturation, and alpha are **preserved** — navy stays navy-family; only its lightness flips. A naïve `255 − c` cannot do this.

- **It inverts the UA *system colors*, which is why a page with zero CSS still goes dark.** The hook covers explicit colors, `color-function`s, and `SystemColor` results — `Canvas`, `Canvastext`, the page's default backdrop. A page that authored *no* background inherits a dark canvas with **no agent stylesheet and no injected `html { background }`**. That is a thing only the cascade can do, and gjoa does it in the cascade. `currentColor`, `color-mix()`, and unresolved relative colors stay symbolic and compose against the already-inverted values — so the algebra never double-inverts.

- **The no-flash guarantee is a consequence of a *correctness* decision.** In hybrid mode a top document **starts un-inverted**, so its first cascade computes the authored colors accurately. `PresShell::Initialize` then calls `ApplyHybridDefaultInvertIfThemeless()` after the root frame is built but **before paint is unsuppressed**: it reads the authored root background, and if it's transparent or luminance `≥ 0.22` (themeless), it sets a durable bit and re-derives — so the page renders dark **from frame one**. A page that authored its own dark theme is left native. The original "invert everything, then un-invert dark pages" design was rejected in review (`docs/darkmode-v2-tier-b-design.md`) because `Y → 1−Y` is **not losslessly reversible** after channel clamping — saturated darks like navy and maroon would misclassify. So the polarity reads the authored color directly and *never* tries to recover it from an inverted read. The absence of flash isn't a tuning result. It's a theorem.

- **It's live-toggleable, per-document, content-only.** The pref `gjoa.darkmode.invert.enabled` is registered in `gExactCallbackPrefs`; flipping it triggers `UpdateColorInversion → MediaFeatureValuesChanged →` restyle, with no reload. Chrome UI and image documents are hard-excluded. Per-site precedence rides an IPC-replicated `colorInversionOverride` synced `BrowsingContext` field (`none`/`inactive`/`active`), gated to the top BC; subframes inherit. Even the blank canvas *between* navigations is run through the same `Adjust`, so no white frame ever flashes behind a suppressed paint.

The inverted color is a first-class style value, queryable via `getComputedStyle`, composable with `color-mix()`. An extension can only dream of that, because an extension never had the resolved color in the first place.

### Existence proof #2 — The request is never made, not blocked after the fact

A WebExtension blocker watches requests go by and asks the browser to cancel them through a `webRequest` callback. MV3 took even *that* away — full uBlock Origin can no longer run on Chrome in 2026. Brave's answer was to patch blocking directly onto Chromium, below the extension layer, where Google can't remove it. gjoa made the same bet, on Gecko, and proved it on a real binary.

- **Brave's adblock-rust is compiled into libxul.** `engine/toolkit/library/rust/shared/Cargo.toml` vendors `adblock = "0.12.1"` with `full-regex-handling`. The Rust crate `content_classifier_engine` wraps `adblock::Engine` and exposes a C ABI. This is real native code, in-process, not a sandboxed extension.

- **Blocking is wired into Gecko's actual channel-classification path.** `AsyncUrlChannelClassifier` calls `ContentClassifierService::ClassifyForCancel(...)` on the *same async URL-classifier pipeline Firefox already uses for tracking protection* — before the request goes out. A hit routes to `httpChannel->CancelByURLClassifier(NS_ERROR_TRACKING_URI)` (`ContentClassifierService.cpp`). The service is `MAIN_PROCESS_ONLY`: the engine lives **once in the parent process**, not per-tab, not per-frame. The blocked request is never made. There is no packet to measure and nothing to message.

- **It's uBO-list-native.** A drop-in `ContentClassifierRemoteSettingsClient.sys.mjs` overlay (same contract id as the stock client) cache-first loads **EasyList, EasyPrivacy, and six uBlock Origin lists**, refreshes them when older than four days, then `setFilterListData` + `applyFilterLists`. Mozilla's stock path ships no dump and blocks nothing; gjoa replaces the *sourcing*, not the engine.

- **Cosmetic filtering is a native query plus one user sheet.** The Rust `url_cosmetic_resources` returns hide selectors; the `GjoaCosmetic{Parent,Child}` actor pair loads **one `USER_SHEET` of `{display:none!important}`** — page-CSS-proof, the same mechanism uBO uses. Crucially, the parent derives the document URL from **trusted parent-process state** (`manager.documentURI.spec`), never from the hostile content process — closing a cross-site cosmetic-query oracle that content-script blockers structurally cannot.

- **The scriptlet engine is uBO-parity — 163 resources, 872 KB, compiled in.** `setScriptletResources` stores a `Vec<adblock::resources::Resource>`; every block engine can expand `+js(...)` rules into an injectable script via `Engine::use_resources`. Scriptlets inject at document-start in the page's **real main world** through a privileged `Cu.Sandbox(win, {sandboxPrototype: win, wantXrays: false})` — immune to the page's CSP (it works on YouTube, which blocks inline `<script>`), landing writes on the page's *actual* globals.

- **It blocks the ad the network layer can't touch.** First-party YouTube video ads come from `googlevideo.com` — the same origin as the video. No network rule can distinguish them. So gjoa's curated `json-prune` scriptlet patches `JSON.parse` / `ytInitialPlayerResponse` from that CSP-immune sandbox at document-start, deleting `adPlacements`/`adSlots`/`playerAds` *before YouTube's player ever reads them*. Proven end-to-end against a live watch page in `tests/integration/youtube-scriptlet.bjs`.

This is the same move as the dark-mode inverter: push the capability below the content layer, into the engine, where it's cached, un-removable, and structurally correct. Two proofs, one pattern. That repetition *is* the argument.

---

## How five patches buy all of this

Here's the part a fork engineer will want to see, because it's the part that's usually a lie. The entire native surface area is **five patches** (`patches/`):

- `0001` / `0002` — two-line registration shims (a mozbuild include; a BrowserGlue import of the chrome loader).
- `0007` — enable SQLite FTS5.
- `0008` — the cosmetic-adblock content classifier.
- `0009` — the Servo-stage dark-mode inverter.

That's it. Everything else — vertical tab trees, spaces, the vim keymap, the new-tab page, the entire user-facing surface — is chrome JS or `.sys.mjs` overlay. Every patch carries a `baseline-firefox:` header for drift detection, so a Firefox version bump rebases against a tiny, well-documented patch set instead of a sprawling fork.

The reason this works is a discipline: **three build lanes indexed to where the change lives.**

- **Lane 1** — chrome JS/CSS → `gjoa sync` + restart → **~1 second, no rebuild.**
- **Lane 2** — `.sys.mjs` overlay / patch / branding → `mach build faster` → **~30 seconds.**
- **Lane 3** — C++/Rust / version bump → full build → **30–60 minutes.**

The rule is "default everything to Lane 1 until it provably can't reach." And the trick that keeps the engine features from needing an engine rebuild per tweak is the **two-half pattern**: the expensive native mechanism is compiled into libxul once, behind a pref; the entire user-facing policy lives in a hot-reloadable chrome module that flips that pref. Dark mode's five modes (`off`/`system`/`engine`/`filter`/`hybrid`) are *all* chrome (`dark-mode/index.bjs`) flipping `gjoa.darkmode.invert.enabled`. The C++ that does the inversion compiled once, months ago, and never has to compile again.

The whole chrome layer is authored in **Beagle**, a typed Clojure→JS language, and it spans the *entire* stack: chrome UI, the ESM bootstrap, the build tooling, the integration tests, the Firefox pref files (`pref(...)` via a macro), and even the Nix config (`.bnix`). One mental model from the tab tree to the package definition. A custom in-`omni.ja` loader (`GjoaLoader.bjs`) watches `chrome-document-loaded` and, in dev, loads `.uc.js`/`.uc.css` straight off disk — sub-second hot reload with no fx-autoconfig. And `bun run check` runs `BEAGLE_PURITY=error beagle check`: a function not ending in `!` whose body mutates *fails the build* (`E019`). The absence of `!` is a guarantee you can reason on — a correctness floor TypeScript can't offer at any `--strict` setting.

---

## Privacy by default, performance as proof

gjoa does not ask you to trade privacy for speed. The same architectural move delivers both, because the move is "do it in the engine, once, cached."

**We don't benchmark against vanilla Firefox.** Beating stock Firefox — already PGO+LTO — by a few percent is real but boring. The honest, devastating comparison is **Firefox + Dark Reader + an ad blocker**: the stack a privacy-conscious power user assembles by hand to make the browser livable. gjoa does all three jobs engine-natively at near-zero per-frame cost. On a script-heavy, ad-heavy dark page, that isn't a few percent faster — it's a *different cost class*.

And "zero per-frame cost" here is a **structural property, not a tuning result**. The inverted color is a cached `ComputedValues` entry. The blocked request is a single parent-process channel cancellation before the packet leaves. There is no content script re-sampling colors every frame, and no `webRequest` round-trip per request. The work happens at cascade/classification time; every frame after is free.

The privacy default is *the same mechanism* as the speed win, which is why there's nothing to detect, throttle, or remove. The request that's never made can't be timed by a server. The inversion that's a cached style value can't be raced. **Un-removable-because-it's-native is also unprofilable-because-it's-native.** First-party requests are deliberately skipped at classification time (`ContentClassifierEngine.cpp` — "no classification on third-party resources for webcompat; this early-return saves CPU cycles") — the webcompat-correct path is also the cheap path.

gjoa also *refuses the fake privacy win that slows you down.* We rejected a "lean/privacy" pref profile that disabled prefetch, DNS-prefetch, and speculative connections — settings that leak intent to servers *and* measurably hurt page load. gjoa's privacy comes from **not making the request at all**, not from kneecapping the network stack. Where the speed-vs-privacy tension is real, it's an explicit, labeled knob — never a silent slow-but-"private" default.

When we report numbers, we report a baseline and a workload class behind 95%-CI harnesses — *"faster on script-heavy dark sites vs Firefox + Dark Reader,"* never a bare "50% faster." Against an efficient tool like uBlock the delta is small, and we say so. Against the real-world stack on the workloads that hurt, the gap is large *and reproducible* — a claim a skeptical Firefox engineer can re-run, which is worth more than one they can dismiss.

> *The fastest request is the one your browser never makes — and the fastest dark mode is the one that was a cached style value before the first pixel painted. gjoa's privacy isn't a tax on your speed; it's the reason there's nothing left to slow you down.*

---

## The AI-native substrate — the page as a model, not pixels

> **Status: PROPOSED.** Everything above this line ships today. This section is a design, not a claim — but it's defensible *because* it's the third repetition of a move we already made twice.

gjoa compiled a Rust crate (adblock-rust) into libxul and exposed it to chrome JS through a contract id. That is *exactly* how gjoa would ship a small-LLM runtime: vendor a llama.cpp/wgpu-class crate into libxul, expose a C ABI, run it `MAIN_PROCESS_ONLY`, drive it from Lane-1 chrome. An engineer who's read patch `0008` cannot dismiss this, because it's the identical pattern with a different crate.

This framing also *handles the real 2026 constraint instead of hiding it.* Firefox's WebGPU on Linux is still Nightly-only — so gjoa does **not** claim "WebGPU local LLM in the content process today." It doesn't use WebGPU like a webpage. It's a source fork: it links the inference runtime into the engine the way it already linked the ad engine, sidestepping the content-process WebGPU gap entirely. That's both more defensible *and* more on-thesis than pretending to be a web app.

The payoff is unique to being the engine:

- **The model gets the browser's already-computed semantic model for free.** Every other "AI reads the page" product re-derives structure the engine already has — screenshot-and-OCR, or fighting the DOM from a content script. gjoa's engine has *already* parsed, styled, and laid out the page into the accessibility tree and `ComputedValues` (the same `ComputedValues` the dark-mode hook writes into). A local model in the parent reads that resolved model directly. The page as a clean semantic substrate, not pixels to re-interpret.

- **The agent's action channel already exists, already CSP-immune.** The scriptlet sandbox (`Cu.Sandbox(win, {sandboxPrototype: win})`) already injects into the page's real globals at document-start, today, carrying ad-pruning. That is precisely the channel an agent needs to read live state and write back into the real world. It's built.

- **Per-site capability grants aren't a new subsystem — they're the adblock allow-list and the dark-mode BC override, generalized.** gjoa already carries durable, IPC-replicated per-top-document policy: the `colorInversionOverride` synced field and the per-site `@@||host^$document` allow-host exceptions, both derived from the *trusted parent-process URL*. A grant of "this site may be read / may be acted upon / no AI" is the same channel — engine-enforced, un-spoofable by a hostile page, not a permission prompt a content script can be tricked past.

- **The two-half pattern again: the runtime compiles once, the policy iterates in Lane 1.** You don't rebuild the engine to change what the agent can do. The prompts, the agent loop, the per-site grants, the tool wiring — all hot-reloadable Beagle chrome behind prefs. `gjoa sync` and restart.

**The credibility anchor is restraint.** The honest 2026 envelope for a 3B–8B Q4/Q5 model (Phi-4-mini, Llama 3.3 8B, Mistral Small) running ~15–50 tok/s on gjoa's discrete-GPU Linux target is: summarize, extract, rewrite, page-Q&A, classify, smart history/tab search. That "approaches GPT-3.5-class" on those tasks — and gjoa would promise *exactly that* and explicitly **not** frontier reasoning on-device. That line — local for what local does well, nothing phoned home — is exactly where Dia ships your page to OpenAI and where Mozilla's own AI push triggered a kill-switch revolt. gjoa needs no kill switch, because there's nothing to kill: no cloud call, no extension, no MV3 cap, no off-switch to negotiate with anyone over.

> *The browser has already parsed, styled, and laid out the page into a perfect semantic model — and then thrown it away at the content boundary so an extension can screenshot it back. gjoa keeps the model and hands it to a local agent: the page as a substrate, the engine as the runtime, your machine as the only server.*

---

## Power-user-native — spaces, keyboard, compositor

gjoa treats the window manager and the keyboard as the browser's *real* interface.

- **Spaces are bound to the OS compositor, not faked in a tab strip.** `spaces/niri.bjs` spawns `niri msg event-stream` via XPCOM `Subprocess`, frames the newline-delimited JSON itself, and maps niri workspace focus → gjoa space (debounced, with a pure reducer for unit testing). Switch workspaces in niri and the browser follows. No Firefox-family browser — not Zen, not Vivaldi, not the dead Arc — wires workspaces to the Wayland compositor. The binding is one-way today *by deliberate design*: a `__niriDriving` guard prevents feedback ping-pong, and the gjoa→niri reflector is the scaffolded next step. The hard part — loop prevention — is already solved.

- **The chrome is genuinely hackable, not "supports a userChrome.css."** It's one typed language with sub-second hot-reload. Edit a tab-tree behavior, `gjoa sync`, restart — **~1 second**. The power user's changes iterate at the exact speed the maintainers' do. And the hackability comes with a safety rail no userChrome hack has: enforced purity (`E019`). You can rewrite your browser's chrome and the compiler still guarantees which of your functions are side-effect-free.

- **Vertical tab tree + spaces + vim keymap are first-class** — on an engine Firefox took a *decade* to give native vertical tabs to (FF136, 2025), and still has no native workspaces. The horizontal↔vertical toggle corruption is already fixed (transient `layoutCollapsed` flag, never persisted; 6/6 tests pass). Compile-time macros let the chrome read like a DSL for the browser: `(mi "Close Tab" h)`, `(xul "tab" cls)`, `(pref-bool name default)` inline to raw DOM/XPCOM/pref primitives at compile time. You edit intent, not boilerplate.

> *It's the first Firefox that's an extension of your desktop, not an app sitting on top of it.*

---

## Next actions — the sequenced build order

Every item below is the *same two-half move gjoa already shipped twice*: a native mechanism in libxul behind a pref, plus a Lane-1 chrome control half that iterates in one second. Nothing here is a new subsystem. Each is the next turn of a crank that already runs. The understatement is the point — these are genuinely small.

### NEAR — extends systems already in the binary

- **Tunable inversion strength + theme synthesis, at the same call site.** The flip is one parameterized line today — `let target = 1.0 - lum;`. Generalize to `target = mix(lum, 1−lum, strength)` plus an accent/warmth knob and you get *"dim," "full dark," "sepia"* as **cached engine settings**, not three extensions — live through the `gExactCallbackPrefs` + restyle plumbing that already toggles modes with no reload. A strength slider costs one restyle, not a per-frame pass.

- **Per-element inversion policy — promote the image exclusion into the cascade.** Today the legacy `filter` mode special-cases `img`/`video`/`canvas`/`svg` in chrome CSS (`dark-mode/index.bjs`). The right home is the `to_computed_color` hook itself, gated by element type — photos stay true-color, text and UI invert, no compositor filter. The hook is already keyed on a single `device().color_inversion()` bool; this widens that bool into a per-element policy read.

- **Guaranteed-legible dark mode — a WCAG-AA contrast pass on the primitive that's already there.** `invert_color_luminance` already computes the `(L+0.05)` ratio form. A follow-on hook can, when a computed text color and its *resolved* background fall below 4.5:1 after inversion, nudge the text luminance to restore it. **No extension can do this** — it needs the resolved background, which only the cascade holds. This is the sharpest "the engine can do what a content script structurally cannot" win available.

- **First-party adblock isolation — flip an existing early-return into a real budget.** `CheckNetworkRequest` already early-returns on the first-party skip (`ContentClassifierEngine.cpp`) for webcompat + CPU. Promote that skip into a per-site *resource budget* (max third-party requests/bytes) on the exact same `ClassifyForCancel` cancellation path. Policy, not new mechanism.

- **The curated-override registry grows as DATA, not code.** Dark mode's site fixes (`darkmode-fixes.json`) and adblock's lists both ride a "stash bytes, then apply" runtime API — `setFilterListData(name, bytes)` / `applyFilterLists()` and `mirrorOverridesPref`. Expanding coverage to thousands of sites is a data round-trip with **zero engine change** (`GjoaDarkmodeParent.sys.mjs`).

### MID — the AI substrate MVP, built the *exact* way adblock-rust was

- **Ship a 3B–8B model as an engine-native service** — the same move that put adblock-rust in libxul. One native component, `MAIN_PROCESS_ONLY`, C ABI to the Lane-1 chrome layer. This deliberately **bypasses the content-process WebGPU gap** (Nightly-only on Linux in 2026) by wiring inference directly into the engine instead of pretending to be a webpage.

- **First capability runs over the live a11y tree, not a screenshot or a cloud call.** Summarize / extract / page-Q&A over the accessibility tree the engine already maintains — local, cached, zero-cloud. The on-thesis answer to the kill-switch revolt: there's nothing to phone home and nothing to switch off. Honest scope only — summarize, classify, rewrite, find/extract, smart search — exactly the band a 3B–8B model handles.

### FAR — agentic browsing on rails gjoa already laid

- **Per-site capability grants, enforced on the trusted parent-process URL the blocker already derives.** The cosmetic actor already proves the model: the document URL comes from `manager.documentURI.spec`, *never* the content process. An agent that reads, extracts, fills, or navigates rides the same per-site allow-list channel (`@@||host^$document`-style exceptions, the `colorInversionOverride` BC field) — so grants are **engine-enforced and un-spoofable by the page**, not a prompt a hostile script can slip past.

> *Every line of this roadmap is the same move we already made twice: compile the mechanism into the engine once, then iterate the policy in chrome in one second forever after. We're not planning new subsystems — we're turning a crank that already runs.*

---

## This is what Firefox should have been

Firefox's desktop share is bleeding — and the base that remains is exactly who gjoa is for: privacy-conscious power users, Linux desktops, people who assembled a livable browser by hand out of extensions and now watch Manifest V3, AI-by-default, and telemetry creep take the pieces away one at a time.

Every one of those bolt-ons was the engine admitting it didn't have a feature. Dark Reader is the engine admitting it can't invert a color. uBlock is the engine admitting it won't cancel a request. A cloud AI button is the engine admitting it threw away the page model it just built. gjoa's whole thesis is that *none of those admissions were necessary* — the engine can invert the color at cascade time, cancel the request at the classifier, and keep the page model for a local agent. We didn't theorize the first two. We shipped them, in five patches, and wrote down exactly where.

Once you've seen a dark mode that was a cached style value before the first pixel painted, asking the browser to host an extension that fakes it feels like asking it to wear a costume of itself.

> *Every browser lets you install dark mode and ad blocking. gjoa is a browser that does them. The difference is the difference between a costume and a body — and we're about to put a local agent in the body too.*
