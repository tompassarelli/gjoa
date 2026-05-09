import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths";

export interface GjoaConfig {
  name: string;            // "Gjoa"
  binaryName: string;      // "gjoa"
  appId: string;           // "gjoa"
  vendor: string;          // "tompassarelli"
  displayVersion: string;  // "0.1.0"
  license: string;         // "MPL-2.0"
  github: string;          // "tompassarelli/gjoa"
  firefox: {
    version: string;       // "150.0"
    candidate: string;     // "150.0"
    candidateBuild: number;// 1
  };
  branding: {
    shortName: string;     // shows up in titlebar, dialogs
    shorterName: string;   // notification UIs
    fullName: string;      // formal UI surfaces
    productName: string;   // version-stable product reference
    vendorName: string;    // company/maker reference
    backgroundColor: string;
    displayName: string;   // MOZ_APP_DISPLAYNAME (Linux .desktop, etc)
  };
  urls: {
    homepageOverride: string;       // "" disables the post-update whatsnew tab
    welcome: string;                // "" disables first-run welcome
    welcomeAdditional: string;      // "" disables secondary welcome
    updateManual: string;
    updateDetails: string;
    releaseNotes: string;
    releaseNotesAboutDialog: string;
    releaseNotesPrompt: string;
    updateHostname: string;         // hostname for app.update.url. "invalid" TLD = no-op
  };
}

let cached: GjoaConfig | null = null;

export function loadConfig(): GjoaConfig {
  if (cached) return cached;
  const path = join(REPO_ROOT, "gjoa.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as GjoaConfig;
  validate(parsed);
  cached = parsed;
  return parsed;
}

function validate(c: GjoaConfig): void {
  const required: (keyof GjoaConfig)[] = [
    "name", "binaryName", "appId", "vendor", "displayVersion",
    "license", "github", "firefox", "branding", "urls",
  ];
  for (const k of required) {
    if (c[k] === undefined) throw new Error(`gjoa.json missing required field: ${k}`);
  }
  if (!c.firefox.version) throw new Error("gjoa.json: firefox.version is required");
  if (!c.binaryName.match(/^[a-z0-9-]+$/)) {
    throw new Error(`gjoa.json: binaryName "${c.binaryName}" must be lowercase alphanumeric+hyphen`);
  }
}
