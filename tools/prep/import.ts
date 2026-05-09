import { branding } from "./branding";
import { mozconfig } from "./mozconfig";
import { overlay } from "./overlay";
import { patches } from "./patches";
import { log } from "./log";

// Four sequential phases. Each is idempotent, so re-running `bun run import`
// after editing src/gjoa/ or gjoa.json picks up the changes correctly.
export async function importSources(): Promise<void> {
  log.step("phase 1/4 — overlaying src/gjoa/");
  await overlay();

  log.step("phase 2/4 — applying patches/");
  await patches();

  log.step("phase 3/4 — generating branding");
  await branding();

  log.step("phase 4/4 — generating engine/mozconfig");
  await mozconfig();

  log.ok("import complete");
}
