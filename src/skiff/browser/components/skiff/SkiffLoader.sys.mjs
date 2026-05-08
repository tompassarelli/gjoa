// Skiff chrome JS/CSS loader.
//
// Replaces fx-autoconfig with a Firefox-native loader that lives inside
// omni.ja (install-root-owned) instead of bouncing through profile-side
// chrome/ directories.
//
// =============================================================================
// SECURITY MODEL
// =============================================================================
//
// PRODUCTION (no <install_root>/skiff-dev/ directory present):
//   Scripts and styles load from omni.ja via chrome:// URLs. Same trust
//   boundary as Firefox itself — if you trust the install, you trust the
//   chrome JS. No user-writable script directory exists; no hash-pinning
//   needed because there's nothing to tamper with.
//
// DEV MODE (<install_root>/skiff-dev/ directory present):
//   The loader reads .uc.js / .uc.css files from <install_root>/skiff-dev/
//   directly at startup. Used for sub-second iteration on chrome JS without
//   re-running mach build. Trust boundary: anyone who can write to the
//   install root (typically root, or the dev who owns the build tree) can
//   inject scripts. This is identical to "anyone who can write to the install
//   root can replace the binary" — same threat boundary, no new attack
//   surface.
//
// PRODUCTION HARDENING (deferred — see Stretch goal):
//   For shipped release builds, dev mode should be compiled out via a
//   build flag (e.g. MOZ_SKIFF_DEV_LOADER=0). Even though the dev path
//   only triggers when <install_root>/skiff-dev/ exists, defense-in-depth
//   says don't compile in code paths your release doesn't need. Open issue:
//   add MOZ_SKIFF_DEV_LOADER preprocessor define + #ifdef around dev block.
//
// =============================================================================
// IMPLEMENTATION
// =============================================================================

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  // (none yet — placeholder for future lazy imports)
});

const STYLE_SHEET_SERVICE = Cc["@mozilla.org/content/style-sheet-service;1"]
  .getService(Ci.nsIStyleSheetService);

// browser.xhtml is the only chrome document we want to inject into for now.
// Restricting by document URL avoids accidentally double-loading into popup
// windows, sidebar inner frames, etc.
const TARGET_BROWSER_URL = "chrome://browser/content/browser.xhtml";

// In-memory tracking so we don't double-load (chrome-document-loaded fires
// once per chrome doc, but if our loader is re-imported we want to be safe).
const loadedSheets = new Set();
let observerRegistered = false;

// -----------------------------------------------------------------------------
// Source resolution
// -----------------------------------------------------------------------------

/**
 * Returns the dev-mode source directory if it exists, else null.
 * Convention: <install_root>/skiff-dev/{JS,CSS}/*.uc.{js,css}
 */
function devModeDir() {
  // GreD = Gecko runtime directory = the install root containing the binary.
  const dir = Services.dirsvc.get("GreD", Ci.nsIFile);
  dir.append("skiff-dev");
  if (dir.exists() && dir.isDirectory()) return dir;
  return null;
}

function listFiles(dir, suffix) {
  const out = [];
  if (!dir.exists() || !dir.isDirectory()) return out;
  const entries = dir.directoryEntries;
  while (entries.hasMoreElements()) {
    const f = entries.getNext().QueryInterface(Ci.nsIFile);
    if (f.isFile() && f.leafName.endsWith(suffix)) out.push(f);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

function loadScriptInto(window, file) {
  const url = Services.io.newFileURI(file).spec;
  try {
    Services.scriptloader.loadSubScriptWithOptions(url, {
      target: window,
      ignoreCache: true,
    });
    console.log(`skiff-loader: loaded script ${file.leafName}`);
  } catch (e) {
    console.error(`skiff-loader: script ${file.leafName} threw at load time`, e);
  }
}

function registerStyleSheet(file) {
  const url = Services.io.newFileURI(file).spec;
  if (loadedSheets.has(url)) return;
  try {
    const uri = Services.io.newURI(url);
    STYLE_SHEET_SERVICE.loadAndRegisterSheet(uri, STYLE_SHEET_SERVICE.AGENT_SHEET);
    loadedSheets.add(url);
    console.log(`skiff-loader: registered stylesheet ${file.leafName}`);
  } catch (e) {
    console.error(`skiff-loader: stylesheet ${file.leafName} threw at register time`, e);
  }
}

function loadIntoChromeWindow(window) {
  const dev = devModeDir();
  if (!dev) {
    // Production: nothing yet. Future commit will load from
    // chrome://skiff/content/scripts/*.uc.js and chrome://skiff/content/styles/*.uc.css.
    // For now, no-op — production builds simply ship without the chrome layer.
    return;
  }

  const jsDir = dev.clone();
  jsDir.append("JS");
  const cssDir = dev.clone();
  cssDir.append("CSS");

  // Stylesheets are global — register once (loadAndRegisterSheet is idempotent
  // via our loadedSheets cache anyway).
  for (const css of listFiles(cssDir, ".uc.css")) {
    registerStyleSheet(css);
  }

  // Scripts are per-window — load each one against the freshly-opened
  // chrome window.
  for (const js of listFiles(jsDir, ".uc.js")) {
    loadScriptInto(window, js);
  }
}

// -----------------------------------------------------------------------------
// Observer registration (called from BrowserGlue at app-startup)
// -----------------------------------------------------------------------------

const observer = {
  observe(subject, topic) {
    if (topic !== "chrome-document-loaded") return;
    // subject IS the Document directly (chrome-document-loaded contract);
    // no QueryInterface dance — nsIDOMDocument was removed years ago.
    const doc = subject;
    const window = doc?.defaultView;
    if (!window) return;
    if (window.location?.href !== TARGET_BROWSER_URL) return;
    loadIntoChromeWindow(window);
  },
};

export const SkiffLoader = {
  start() {
    if (observerRegistered) return;
    observerRegistered = true;
    Services.obs.addObserver(observer, "chrome-document-loaded");
    const dev = devModeDir();
    if (dev) {
      console.log(`skiff-loader: dev mode active — sourcing chrome from ${dev.path}`);
    } else {
      console.log("skiff-loader: production mode (no skiff-dev/ override; chrome scripts not loaded)");
    }
  },
};
