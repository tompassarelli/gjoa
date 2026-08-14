# gjoa dark mode

gjoa dark mode is one decision pipeline spanning the chrome controller, native engine
prefs, the pre-paint color transform, and per-document actor refinements. The current
user-facing modes are `dark`, `uniform`, `light`, `system`, and `off`.

## Modes

| Mode | Behavior |
|---|---|
| `dark` | Default. Advertises a dark color scheme so sites can use their native dark theme; engine-inverts themeless pages before first paint; enables per-site decisions. |
| `uniform` | Forces the page's light theme and luminance-inverts every page into the configured dark band. |
| `light` | Forces a light color scheme and applies no inversion. |
| `system` | Resolves to the `dark` behavior on a dark OS and the `light` behavior on a light OS. |
| `off` | Parks dark-mode treatment and leaves content without a color-scheme override. |

`gjoa.darkmode.enabled=false` also parks the system. It is the master switch; `off` is
the corresponding mode value.

The controller in `src/gjoa/chrome/bjs/dark-mode/index.bjs` translates each mode into
one tuple:

| Mode arm | Chrome scheme | `content-override` | `invert.enabled` | `hybrid.default-invert` | RFP scheme exemption |
|---|---:|---:|---:|---:|---:|
| `dark` | dark | `0` (dark) | `false` | `true` | on |
| `uniform` | dark | `1` (light) | `true` | `false` | off |
| `light` | light | `1` (light) | `false` | `false` | off |
| `system` on dark OS | dark | `0` (dark) | `false` | `true` | on |
| `system` on light OS | light | `1` (light) | `false` | `false` | off |
| `off` or disabled | light | `2` (none) | `false` | `false` | off |

`gjoa.darkmode.hybrid.default-invert` is the current engine coordinate for the
pre-paint themeless-page decision. “Hybrid” here names that internal implementation
mechanism, not a user-facing mode.

## Override hierarchy

The narrowest applicable decision wins:

1. `gjoa.darkmode.enabled` decides whether the subsystem runs.
2. `gjoa.darkmode.mode` selects the global behavior.
3. In `dark` behavior, the user host lists apply with this precedence:
   `user.off` > `user.force-invert` > `user.force-native`.
4. `darkmode-fixes.json` supplies curated host CSS, injection, and explicit inversion
   decisions.
5. The document actor may refine an undecided page from its rendered luminance and
   normalize low-contrast text.

The host-list prefs are:

- `gjoa.darkmode.user.off`: no dark-mode treatment for the host.
- `gjoa.darkmode.user.force-invert`: always invert the host.
- `gjoa.darkmode.user.force-native`: preserve the site's authored appearance.

## Current control flow

```text
BOOT
  dark-mode-prefs.bjs supplies baked defaults
    enabled=true, mode=dark

CHROME INIT
  index.bjs installs pref + OS-theme observers
  apply! writes the mode tuple above

PRE-PAINT ENGINE
  nsPresContext derives the document inversion state
  ApplyHybridDefaultInvertIfThemeless decides the dark-mode default before paint
  the role-aware OKLCH transform maps colors into the dark band
  GjoaDarkText solves text against the composited backdrop

DOCUMENT START
  GjoaDarkmodeChild applies synchronous explicit host decisions
  GjoaDarkmodeParent supplies curated fixes and user-list precedence

POST LOAD
  undecided pages can be measured and refined
  large media is dimmed without recoloring photographs
  APCA normalization corrects low-contrast text
```

The implementation surfaces are:

- `src/gjoa/defaults/pref/dark-mode-prefs.bjs`: default values.
- `src/gjoa/chrome/bjs/dark-mode/index.bjs`: global mode controller.
- `src/gjoa/toolkit/components/content-classifier/GjoaDarkmodeParent.sys.mjs`:
  host policy, curated fixes, and painted-page decisions.
- `src/gjoa/toolkit/components/content-classifier/GjoaDarkmodeChild.sys.mjs`:
  document-start application and post-load refinement.
- `src/gjoa/toolkit/components/content-classifier/darkmode-fixes.json`: curated host data.
- `patches/0009-dark-mode-engine-color-inversion.patch`, `patches/0012-dark-mode-role-resolver.patch`,
  `patches/0013-dark-mode-text-solve.patch`, and `patches/0014-dark-mode-tier0.patch`:
  native engine behavior.

## Main prefs

| Pref | Meaning |
|---|---|
| `gjoa.darkmode.mode` | One of the five current modes. |
| `gjoa.darkmode.invert.bgLightness` | OKLCH lightness floor for inverted page backgrounds. Lower is darker. |
| `gjoa.darkmode.invert.fgLightness` | OKLCH lightness ceiling for inverted foreground colors. |
| `gjoa.darkmode.scrim.alpha` | Dark scrim strength over large photographic surfaces. |
| `gjoa.darkmode.normalize.enabled` | Enables backdrop-aware APCA text normalization. |
| `gjoa.darkmode.normalize.floor` | Minimum APCA contrast target. |
| `gjoa.darkmode.image-analysis.enabled` | Enables the optional post-load image refinement pass. |
| `gjoa.darkmode.media-dim.pct` | Brightness applied to large media on inverted pages. |

`layout.css.prefers-color-scheme.content-override` uses Gecko's values: `0` dark,
`1` light, and `2` no override. `privacy.resistFingerprinting.overrides` receives
`+AllTargets,-CSSPrefersColorScheme` only while the dark behavior needs native-dark
site selection and only when gjoa owns the value.

## Design invariants

Dark mode preserves legibility relationships rather than transforming isolated colors.
The implementation follows these invariants:

1. Readability belongs to the ordered pair `(mark, composited backdrop)`, not either
   color alone.
2. Surface roles are resolved before foreground roles. Freeze the surface, then solve
   each mark against it.
3. Move lightness while preserving hue and never inventing chroma. Reduce chroma only
   when gamut mapping requires it.
4. Keep contrast inside a two-sided band: enough separation to read, without the
   halation of maximum-white text on maximum-black surfaces.
5. Do not recolor photographs. Exclude them from the color transform and use a neutral
   scrim or brightness reduction when needed.
6. A site that already supplies a legible dark design remains native.

OKLCH supplies the lightness/hue/chroma coordinates. APCA is the contrast instrument
used by the text solver and regression harness. The exact band bounds are product
parameters, not universal constants.

## Development and verification

Chrome controller changes are Lane 1 and flow through the normal bundle loop:

```sh
bun run check
bun run chrome:dist
bun run chrome:install
```

Native color-transform changes alter the patch set and require a new engine build.

The focused checks are:

```sh
bun run test:unit
bun run test:darkmode
bun run test:contrast
bun run darkmode:regress
```

`tools/dm-driver/dm-check.sh` provides a deterministic `uniform`-mode dark-band check.
Its deep sweep captures all five current modes and asserts the dark band only for
`uniform`, whose output is intentionally independent of page and OS theme choices.
