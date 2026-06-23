# dm-driver — tiered dark-mode visual-test driver

A data-driven screenshot driver that renders a curated set of sites through
gjoa's dark-mode engine and asserts the result actually lands in the dark band.
Two tiers:

| tier | command | what it does | wall-time |
|------|---------|--------------|-----------|
| **check** (default) | `bun run dm:check` | each target in **engine** mode at the default darkness (`bgLightness 16`); assert mean luminance < per-target max + (for the white page) bg pixel ≈ `#0d0d0d`. PASS/FAIL table, nonzero exit on any fail. | < ~2 min |
| **deep** | `bun run dm:check:deep` | sweep `{modes} × {bgLightness} × {window sizes} × {targets}`; capture + measure each, write a results matrix + thumbnails. Engine-mode rows are hard asserts; other modes are captures for visual review. | ~15–20 min (full) |

Rendering needs the mach devShell (the binary's runtime libs); the `bun run`
scripts wrap the call in `nix develop .#mach`. To run the script directly:

```sh
nix develop .#mach -c bash tools/dm-driver/dm-check.sh          # check
nix develop .#mach -c bash tools/dm-driver/dm-check.sh --deep   # deep
```

Image analysis (`magick`) runs in the default shell; only the render step needs
the devShell. Shots land in `$DM_OUTDIR` (default `/tmp/dm-check`); deep
thumbnails + `deep-matrix.tsv` land there too.

### How it works

`gjoa --headless … -screenshot OUT.png URL` renders a page then **exits** — no
long-lived browser, no teardown race. Dark mode is set per-render via a fresh
profile `user.js` whose prefs mirror `src/gjoa/chrome/bjs/dark-mode/index.bjs`
(`apply-mode!`): engine mode = `content-override=1` + `invert.enabled=true`
(force light theme so the engine inverts everything to the `bgLightness` floor —
the Dark-Reader-style uniform dark).

Luminance is the **sRGB-honest** Rec.709 luma of the per-channel means. (Do *not*
use `magick -colorspace Gray -format '%[fx:mean]'`: ImageMagick 7 linearizes,
inflating a `#0d0d0d` page to ~0.53 instead of ~0.05.)

SPA targets that client-redirect (e.g. reddit) sometimes kill the Screenshot
actor mid-shot; `render()` retries up to `DM_RENDER_TRIES` (default 3) on an
empty PNG.

## Manifest schema (`manifest.json`)

```jsonc
{
  "schemaVersion": 1,
  "defaults": {
    "windowSize": "1280,800",   // "W,H" passed to --window-size
    "timeoutSec": 90,           // per-render timeout
    "meanLumMax": 0.35,         // default dark-band ceiling (0..1)
    "bgSampleXY": "20,20"       // default pixel to sample for the bg assert
  },
  "targets": [
    {
      "id": "white-page",       // unique; used in filenames + the table
      "kind": "local",          // "local" (inline html) | "url" (remote)
      "html": "<!doctype …>",   // REQUIRED when kind=local; written to a tmp file
      "url":  "https://…",      // REQUIRED when kind=url
      "meanLumMax": 0.20,       // optional per-target override of the ceiling
      "bgHex": "#0d0d0d",       // optional: assert the sampled bg pixel ≈ this …
      "bgTolerance": 0.12,      //   … within this per-channel distance (0..1)
      "bgSampleXY": "20,20"     // optional per-target sample point
    }
  ],
  "deep": {                     // axes for the --deep sweep
    "modes":        ["system", "hybrid", "auto", "engine"],
    "bgLightness":  [8, 16, 24],
    "windowSizes":  ["1280,800", "768,1024"]
  }
}
```

**Assertions** (check tier, and engine rows of the deep tier):

- `meanLum <= meanLumMax` — the whole screenshot's perceived brightness is in
  the dark band.
- if `bgHex` **and** `bgTolerance` are set: the sampled bg pixel is within
  `bgTolerance` (per-channel, 0..1) of `bgHex`. Omit `bg*` for real sites whose
  backgrounds aren't a single flat color.

Non-engine deep rows are **captures, not asserts** — `system`/`auto`/`hybrid` on
a light site legitimately stay light (they follow the OS theme / honor the
site's own theme), so asserting "dark" there would be wrong. They're recorded in
the matrix + thumbnails for eyeball review.

### Extending

Add a target object to `targets` — no code change. Point the driver at an
alternate manifest with `DM_MANIFEST=/path/to.json`. Other env overrides:
`DM_OUTDIR`, `DM_BIN`, `DM_RENDER_TRIES`, `NO_COLOR=1`.

## Files

- `dm-check.sh` — the driver (bash + magick + python3 for JSON/math).
- `manifest.json` — the target list + expectations + deep axes.
- `marionette_shot.py` lives one dir up in `tools/test-driver/` — a separate,
  dependency-free raw-socket Marionette client used for **render-waited**
  screenshots of pages that build their DOM async (e.g. `about:gjoa`, whose
  settings render only after a registry fetch). `-screenshot` can't wait for
  that, so those shots go through Marionette instead. Example:
  ```sh
  python3 tools/test-driver/marionette_shot.py --port 2829 --privileged \
    --url about:gjoa --wait-selector '#sections' --contains-text 'Dark mode' \
    --out /tmp/about-gjoa-rendered.png
  ```
  (Launch gjoa with `--marionette --remote-allow-system-access` and
  `GJOA_DEV_LOADER=1 GJOA_ALLOW_INSECURE=1` first.)
```
