#!/usr/bin/env python3
"""
DARKCHECK v1 — Channel B pixel audit.

B-rules: mechanical pixel predicates over gjoa-arm screenshots.
Zero model calls. Requires: python3, imagemagick (magick command).

Usage:
  python3 pixelcheck.py [options] [slug ...]

  --dir DIR         screenshot dir (default: /tmp/dr-mark2)
  --arm PREFIX      screenshot arm prefix (default: gjoa)
  --light-arm PFX   light-arm prefix for B3; skip B3 if absent (default: light)
  --rects-dir DIR   dir containing <slug>-rects.json; run unmasked + flag
                    LOW-CONFIDENCE if file missing (default: same as --dir)
  --out FILE        write JSON results to FILE (default: stdout)
  --calib           print calibration summary (PASS/FAIL per rule per slug)

Output JSON: array of result records:
  {page, arm, shot, rule, result, confidence, evidence}
  result = "PASS" | "FAIL"
  confidence = "normal" | "low"  (low when rects.json missing)
  evidence: rule-specific dict
"""

import os, sys, json, subprocess, re, math, tempfile, argparse
from pathlib import Path
from collections import defaultdict
from multiprocessing import Pool, cpu_count

# ── constants ──────────────────────────────────────────────────────────────
VIEWPORT_W = 1600
VIEWPORT_H = 1000
VIEWPORT_PX = VIEWPORT_W * VIEWPORT_H  # 1,600,000

# B1: ≤ this fraction of unmasked pixels may have L* > 60
B1_MAX_BRIGHT_FRACTION = 0.10

# B2: contiguous unmasked region ≥ this many px with median L* > 60 → FAIL
B2_ISLAND_PX = int(VIEWPORT_PX * 0.05)  # 80,000

# B3: mean ΔE76 (CIELAB Euclidean) between gjoa and light arm rect ≤ tolerance
# Lower = more similar (good: image passed through unchanged)
# Higher = image was suppressed/grayscaled/vanished
# Tolerance: 30 covers acceptable dimming; above that, image was damaged.
# Draft for chief sign-off.
B3_DELTA_E_MAX = 30.0

# B4: internal L* std-dev within header band must be ≥ threshold
# (measures logo visibility: too uniform = logo invisible)
B4_HEADER_HEIGHT = 150  # px from top
B4_MIN_LSTAR_STDDEV = 20.0  # L* units; below this → logo region flat → FAIL

# ── helpers ────────────────────────────────────────────────────────────────

def magick(*args, capture=True):
    """Run magick with given args. Return (stdout_bytes, stderr_str) or raise."""
    cmd = ['magick'] + list(str(a) for a in args)
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"magick failed: {r.stderr.decode()[:300]}")
    return r.stdout, r.stderr.decode()


def build_mask_image(rects, out_path, w=VIEWPORT_W, h=VIEWPORT_H):
    """
    Write a white PNG of size WxH with rect regions filled black.
    White = included in analysis; black = excluded (replaced content).
    """
    if not rects:
        # No rects → pure white mask (include everything)
        magick('-size', f'{w}x{h}', 'xc:white', out_path)
        return

    # Build draw commands for each rect
    draw_args = []
    for rect in rects:
        x, y, rw, rh = rect['x'], rect['y'], rect['w'], rect['h']
        x2, y2 = x + rw - 1, y + rh - 1
        draw_args += ['-fill', 'black', '-draw', f'rectangle {x},{y} {x2},{y2}']

    magick('-size', f'{w}x{h}', 'xc:white', *draw_args, out_path)


def lstar_thresholded_masked(img_path, mask_path, tmp_prefix):
    """
    Return (bright_fraction, components_info) where:
    - bright_fraction: fraction of UNmasked pixels with L* > 60
    - components_info: list of {area, bbox} for contiguous bright+unmasked regions
    Uses Lab colorspace; L channel 0-100 maps to 0-100% quantum.
    """
    # Step 1: convert to Lab L-channel image (8-bit for speed)
    l_img = f'{tmp_prefix}_L.png'
    magick(img_path, '-colorspace', 'Lab', '-channel', 'R', '-separate',
           '-depth', '8', l_img)

    # Step 2: apply mask — multiply L image with mask (black areas → 0)
    # We want: excluded rects → L*=0 (dark, won't trigger bright test)
    masked_l = f'{tmp_prefix}_Lmasked.png'
    magick(l_img, mask_path, '-alpha', 'off', '-compose', 'Multiply', '-composite',
           '-depth', '8', masked_l)

    # Step 3: threshold at 60%
    thresh = f'{tmp_prefix}_thresh.png'
    magick(masked_l, '-threshold', '60%', '-depth', '8', thresh)

    # Step 4: compute fraction of white (bright) pixels
    frac_out, _ = magick(thresh, '-format', '%[fx:mean]', 'info:')
    bright_frac_raw = float(frac_out.decode().strip())

    # Adjust fraction to account for masked pixels:
    # mask fraction = fraction of white pixels in mask
    mask_frac_out, _ = magick(mask_path, '-format', '%[fx:mean]', 'info:')
    unmasked_frac = float(mask_frac_out.decode().strip())  # fraction of usable pixels

    # bright_frac_raw = (bright AND unmasked) / total_pixels
    # We want: (bright AND unmasked) / unmasked_pixels
    if unmasked_frac < 0.001:
        bright_fraction = 0.0
    else:
        bright_fraction = bright_frac_raw / unmasked_frac

    # Step 5: connected components for bright regions
    # Use area-threshold to filter tiny noise (< 0.1% viewport = 1600 px)
    cc_out, cc_err = magick(thresh,
        '-define', 'connected-components:verbose=true',
        '-define', f'connected-components:area-threshold=1600',
        '-connected-components', '8', '-auto-level',
        f'{tmp_prefix}_cc.png')

    # Parse component output from stderr (magick writes it to stdout here)
    # Format: "  <id>: <w>x<h>+<x>+<y> <cx>,<cy> <area> <color>"
    components = []
    for line in (cc_out.decode() + cc_err).split('\n'):
        m = re.match(
            r'\s*(\d+):\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+[\d.,]+\s+(\d+)\s+gray\(255\)',
            line)
        if m:
            _, cw, ch, cx, cy, area = m.groups()
            cw, ch, cx, cy, area = int(cw), int(ch), int(cx), int(cy), int(area)
            # Exclude the background component (id=0 is typically the largest dark region)
            components.append({'area': area, 'bbox': {'x': cx, 'y': cy, 'w': cw, 'h': ch}})

    # Sort by area desc
    components.sort(key=lambda c: c['area'], reverse=True)

    return bright_fraction, components, unmasked_frac


def mean_lab_in_rect(img_path, x, y, w, h):
    """Return mean Lab (L, a, b) for a rect in the image."""
    # Crop to rect then get mean of each Lab channel
    crop = f'{x}x{y}+{y}+{x}'  # actually use geometry
    out, _ = magick(img_path,
        '-colorspace', 'Lab',
        '-crop', f'{w}x{h}+{x}+{y}', '+repage',
        '-format', '%[fx:mean.r*100],%[fx:mean.g*200-100],%[fx:mean.b*200-100]',
        'info:')
    parts = out.decode().strip().split(',')
    return float(parts[0]), float(parts[1]), float(parts[2])


def delta_e76(L1, a1, b1, L2, a2, b2):
    """CIE76 ΔE (Euclidean in Lab space)."""
    return math.sqrt((L1-L2)**2 + (a1-a2)**2 + (b1-b2)**2)


def lstar_stddev_region(img_path, x, y, w, h):
    """Compute std-dev of L* values in the region (for B4 logo visibility)."""
    out, _ = magick(img_path,
        '-colorspace', 'Lab',
        '-channel', 'R', '-separate',
        '-crop', f'{w}x{h}+{x}+{y}', '+repage',
        '-format', '%[fx:100*standard_deviation]',
        'info:')
    return float(out.decode().strip())


def mean_lstar_region(img_path, x, y, w, h):
    """Mean L* in region."""
    out, _ = magick(img_path,
        '-colorspace', 'Lab',
        '-channel', 'R', '-separate',
        '-crop', f'{w}x{h}+{x}+{y}', '+repage',
        '-format', '%[fx:mean*100]',
        'info:')
    return float(out.decode().strip())


# ── rule implementations ────────────────────────────────────────────────────

def rule_B1_B2(img_path, mask_path, tmp_prefix, shot):
    """
    B1 + B2 combined (share the expensive imagemagick pass).

    B1: ≤10% of unmasked viewport pixels with L* > 60.
    B2: no contiguous unmasked region ≥5% viewport with median L* > 60.

    Returns (b1_result, b2_result) dicts.
    """
    bright_frac, components, unmasked_frac = lstar_thresholded_masked(
        img_path, mask_path, tmp_prefix)

    # B1
    b1_pass = bright_frac <= B1_MAX_BRIGHT_FRACTION
    b1 = {
        'rule': 'B1',
        'result': 'PASS' if b1_pass else 'FAIL',
        'evidence': {
            'bright_fraction': round(bright_frac, 4),
            'threshold': B1_MAX_BRIGHT_FRACTION,
            'unmasked_fraction': round(unmasked_frac, 4),
            'shot': shot,
        }
    }

    # B2
    worst = None
    failing = []
    for c in components:
        if c['area'] >= B2_ISLAND_PX:
            failing.append(c)
            if worst is None:
                worst = c

    b2_pass = len(failing) == 0
    b2_evidence = {
        'threshold_px': B2_ISLAND_PX,
        'threshold_pct': 5.0,
        'shot': shot,
        'island_count': len(failing),
    }
    if worst:
        b2_evidence['largest_island'] = {
            'area': worst['area'],
            'pct_viewport': round(100 * worst['area'] / VIEWPORT_PX, 1),
            'bbox': worst['bbox'],
        }

    b2 = {
        'rule': 'B2',
        'result': 'PASS' if b2_pass else 'FAIL',
        'evidence': b2_evidence,
    }

    return b1, b2


def rule_B2(img_path, mask_path, tmp_prefix, shot):
    """Legacy wrapper — use rule_B1_B2 for efficiency."""
    _, b2 = rule_B1_B2(img_path, mask_path, tmp_prefix, shot)
    return b2

    # Find worst (largest) island
    worst = None
    failing = []
    for c in components:
        if c['area'] >= B2_ISLAND_PX:
            failing.append(c)
            if worst is None:
                worst = c

    passed = len(failing) == 0
    evidence = {
        'threshold_px': B2_ISLAND_PX,
        'threshold_pct': 5.0,
        'shot': shot,
        'island_count': len(failing),
    }
    if worst:
        evidence['largest_island'] = {
            'area': worst['area'],
            'pct_viewport': round(100 * worst['area'] / VIEWPORT_PX, 1),
            'bbox': worst['bbox'],
        }

    return {
        'rule': 'B2',
        'result': 'PASS' if passed else 'FAIL',
        'evidence': evidence,
    }


def rule_B3(gjoa_path, light_path, rects, shot):
    """
    B3: per replaced-content rect, mean ΔE76 between gjoa and light arm ≤ threshold.
    Skipped if no rects (empty list or None) or no light arm image.
    Returns list of result dicts (one per rect), or None to skip.
    """
    if not rects or not light_path or not os.path.exists(light_path):
        return None

    # Only check img/video/canvas rects
    media_rects = [r for r in rects if r.get('tag', '').lower() in ('img', 'video', 'canvas')]
    if not media_rects:
        return []

    results = []
    for rect in media_rects[:20]:  # cap at 20 rects for speed
        x, y, w, h = rect['x'], rect['y'], rect['w'], rect['h']
        if w < 4 or h < 4:
            continue
        # Clamp to image bounds
        x = max(0, min(x, VIEWPORT_W - 1))
        y = max(0, min(y, VIEWPORT_H - 1))
        w = min(w, VIEWPORT_W - x)
        h = min(h, VIEWPORT_H - y)

        try:
            L1, a1, b1 = mean_lab_in_rect(gjoa_path, x, y, w, h)
            L2, a2, b2 = mean_lab_in_rect(light_path, x, y, w, h)
            de = delta_e76(L1, a1, b1, L2, a2, b2)
            passed = de <= B3_DELTA_E_MAX
            results.append({
                'rule': 'B3',
                'result': 'PASS' if passed else 'FAIL',
                'evidence': {
                    'shot': shot,
                    'rect': {'x': x, 'y': y, 'w': w, 'h': h},
                    'tag': rect.get('tag', '?'),
                    'delta_e76': round(de, 1),
                    'threshold': B3_DELTA_E_MAX,
                    'gjoa_L': round(L1, 1),
                    'light_L': round(L2, 1),
                }
            })
        except Exception as e:
            results.append({
                'rule': 'B3',
                'result': 'ERROR',
                'evidence': {'rect': {'x': x, 'y': y, 'w': w, 'h': h}, 'error': str(e)[:100]}
            })

    return results


def rule_B4(img_path, shot):
    """
    B4: header/nav logo visibility.
    DRAFT rule — requires DOM logo rects from Channel A for accurate operationalization.
    (Spec §4 Wave S: "exact operationalization piloted in wave 1"; threshold for chief
    sign-off.)

    Current heuristic: L* std-dev in top B4_HEADER_HEIGHT px on dark pages.
    Emits result='DRAFT' (not PASS/FAIL) pending chief calibration of threshold.
    Threshold B4_MIN_LSTAR_STDDEV is a draft value.
    """
    try:
        stddev = lstar_stddev_region(img_path, 0, 0, VIEWPORT_W, B4_HEADER_HEIGHT)
        mean_l = mean_lstar_region(img_path, 0, 0, VIEWPORT_W, B4_HEADER_HEIGHT)
    except Exception as e:
        return {
            'rule': 'B4',
            'result': 'ERROR',
            'evidence': {'error': str(e)[:100], 'shot': shot}
        }

    # Compute a provisional verdict (for data, not for gate)
    if mean_l >= 50.0:
        provisional = 'PASS'
        note = 'exempt: header is light (mean L*≥50)'
    elif stddev >= B4_MIN_LSTAR_STDDEV:
        provisional = 'PASS'
        note = 'header has internal contrast (logo likely visible)'
    else:
        provisional = 'FAIL'
        note = 'header is uniform dark — logo may be invisible'

    return {
        'rule': 'B4',
        'result': 'DRAFT',          # never PASS/FAIL until chief signs off threshold
        'evidence': {
            'shot': shot,
            'header_mean_lstar': round(mean_l, 1),
            'header_lstar_stddev': round(stddev, 1),
            'draft_threshold_stddev': B4_MIN_LSTAR_STDDEV,
            'provisional': provisional,
            'note': note,
            'region': {'x': 0, 'y': 0, 'w': VIEWPORT_W, 'h': B4_HEADER_HEIGHT},
        }
    }


# ── main audit logic ────────────────────────────────────────────────────────

def audit_slug(slug, screenshot_dir, arm, light_arm, rects_dir):
    """
    Audit one page slug. Returns list of result dicts.
    """
    results = []

    # Load rects.json
    rects_path = Path(rects_dir) / f'{slug}-rects.json'
    rects = None
    confidence = 'normal'
    if rects_path.exists():
        try:
            rects = json.loads(rects_path.read_text())
        except Exception:
            rects = None
    if rects is None:
        confidence = 'low'
        rects = []  # run unmasked

    with tempfile.TemporaryDirectory(prefix='pixelcheck_') as tmp:
        # Build mask image (shared across shots for this slug)
        mask_path = os.path.join(tmp, 'mask.png')
        build_mask_image(rects, mask_path)

        for shot in ('1top', '2mid'):
            img_filename = f'{arm}-{slug}-{shot}.png'
            img_path = Path(screenshot_dir) / img_filename
            if not img_path.exists():
                results.append({
                    'page': slug, 'arm': arm, 'shot': shot,
                    'rule': 'MISSING', 'result': 'SKIP',
                    'confidence': confidence,
                    'evidence': {'file': img_filename}
                })
                continue

            tmp_pfx = os.path.join(tmp, f'{shot}')

            # --- B1 + B2 (shared computation) ---
            try:
                b1, b2 = rule_B1_B2(str(img_path), mask_path, tmp_pfx + '_B1B2', shot)
                b1.update({'page': slug, 'arm': arm, 'confidence': confidence})
                b2.update({'page': slug, 'arm': arm, 'confidence': confidence})
                results.append(b1)
                results.append(b2)
            except Exception as e:
                for rule in ('B1', 'B2'):
                    results.append({'page': slug, 'arm': arm, 'shot': shot,
                                    'rule': rule, 'result': 'ERROR',
                                    'confidence': confidence,
                                    'evidence': {'error': str(e)[:200]}})

            # --- B3 ---
            light_img_path = Path(screenshot_dir) / f'{light_arm}-{slug}-{shot}.png'
            try:
                b3_list = rule_B3(str(img_path),
                                  str(light_img_path) if light_img_path.exists() else None,
                                  rects, shot)
                if b3_list is None:
                    results.append({
                        'page': slug, 'arm': arm, 'shot': shot,
                        'rule': 'B3', 'result': 'SKIP',
                        'confidence': confidence,
                        'evidence': {
                            'reason': 'no light arm or no media rects',
                            'light_arm_exists': light_img_path.exists(),
                            'rects_count': len(rects),
                        }
                    })
                else:
                    for r in b3_list:
                        r.update({'page': slug, 'arm': arm, 'confidence': confidence})
                        results.append(r)
            except Exception as e:
                results.append({'page': slug, 'arm': arm, 'shot': shot,
                                'rule': 'B3', 'result': 'ERROR',
                                'confidence': confidence,
                                'evidence': {'error': str(e)[:200]}})

            # --- B4 (1top only — logo check at page top) ---
            if shot == '1top':
                try:
                    r = rule_B4(str(img_path), shot)
                    r.update({'page': slug, 'arm': arm, 'confidence': confidence})
                    results.append(r)
                except Exception as e:
                    results.append({'page': slug, 'arm': arm, 'shot': shot,
                                    'rule': 'B4', 'result': 'ERROR',
                                    'confidence': confidence,
                                    'evidence': {'error': str(e)[:200]}})

    return results


# ── calibration report ──────────────────────────────────────────────────────

CALIB_LOSERS = [
    'walmart_com_', 'techcrunch_com_', 'azure_microsoft_com_en_us_',
    'paypal_com_us_home', 'sciencedirect_com_', 'nature_com_',
    'theguardian_com_us', 'nodejs_org_en', 'about_gitlab_com_',
    'news_microsoft_com_',
]
CALIB_WINNERS = ['redis_io_', 'kubernetes_io_', 'washingtonpost_com_']
# Owner faults: pvk.ca + css-tricks not in dr-mark2; youtube + bbc proxies below
CALIB_OWNER_FAULTS = ['youtube_com_', 'bbc_com_news']

EXPECTED_FAIL = set(CALIB_LOSERS + CALIB_OWNER_FAULTS)
EXPECTED_PASS = set(CALIB_WINNERS)


def print_calib_summary(all_results):
    """Print per-slug pass/fail summary for calibration set."""
    # Group by page, rule
    by_page = defaultdict(lambda: defaultdict(list))
    for r in all_results:
        by_page[r['page']][r['rule']].append(r['result'])

    slugs = sorted(set(CALIB_LOSERS + CALIB_WINNERS + CALIB_OWNER_FAULTS),
                   key=lambda s: (s not in EXPECTED_FAIL, s))

    print(f"\n{'SLUG':<38} {'B1':^8} {'B2':^8} {'B3':^8} {'B4':^8}  EXPECTED")
    print('-' * 75)
    total_ok = 0
    total_checked = 0
    for slug in slugs:
        if slug not in by_page:
            print(f"  {slug:<36} (no data)")
            continue
        row = by_page[slug]
        expected = 'FAIL' if slug in EXPECTED_FAIL else 'PASS'

        def cell(rule):
            vals = row.get(rule, [])
            vals_gated = [v for v in vals if v not in ('SKIP', 'ERROR', 'DRAFT')]
            if not vals_gated:
                if 'DRAFT' in vals:
                    return ' DRF  '
                return '  —   '
            if 'FAIL' in vals_gated:
                return ' FAIL '
            return ' PASS '

        b1 = cell('B1')
        b2 = cell('B2')
        b3 = cell('B3')
        b4 = cell('B4')

        # Page-level result: FAIL if any gated rule fails (DRAFT excluded from gate)
        all_vals = [v for vlist in row.values() for v in vlist
                    if v not in ('SKIP', 'ERROR', 'DRAFT')]
        page_result = 'FAIL' if 'FAIL' in all_vals else 'PASS'

        match = '✓' if page_result == expected else '✗'
        if page_result in ('PASS', 'FAIL'):
            total_checked += 1
            if page_result == expected:
                total_ok += 1

        label = '(loser)' if slug in CALIB_LOSERS else \
                '(winner)' if slug in CALIB_WINNERS else '(fault)'
        print(f"  {slug:<36} {b1}{b2}{b3}{b4}  {expected} {match} {label}")

    if total_checked > 0:
        print(f"\nCalibration: {total_ok}/{total_checked} pages match expected verdict "
              f"({100*total_ok/total_checked:.0f}%)")
    print()


# ── module-level worker (picklable for multiprocessing) ─────────────────────

def _audit_one_task(args_tuple):
    """Wrapper for multiprocessing: accepts (slug, screenshot_dir, arm, light_arm, rects_dir)."""
    slug, screenshot_dir, arm, light_arm, rects_dir = args_tuple
    try:
        return audit_slug(slug, screenshot_dir, arm, light_arm, rects_dir)
    except Exception as e:
        return [{'page': slug, 'arm': arm, 'shot': '?',
                 'rule': 'ERROR', 'result': 'ERROR', 'confidence': 'low',
                 'evidence': {'error': str(e)[:300]}}]


# ── entry point ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', default='/tmp/dr-mark2',
                    help='Screenshot directory (default: /tmp/dr-mark2)')
    ap.add_argument('--arm', default='gjoa',
                    help='Screenshot arm prefix (default: gjoa)')
    ap.add_argument('--light-arm', default='light',
                    help='Light arm prefix for B3 (default: light)')
    ap.add_argument('--rects-dir', default=None,
                    help='Dir containing <slug>-rects.json (default: --dir)')
    ap.add_argument('--out', default=None,
                    help='Output JSON file (default: stdout)')
    ap.add_argument('--calib', action='store_true',
                    help='Run calibration set and print summary')
    ap.add_argument('slugs', nargs='*',
                    help='Slugs to audit (default: all in --dir)')
    args = ap.parse_args()

    screenshot_dir = args.dir
    rects_dir = args.rects_dir or args.dir

    # Discover slugs
    if args.calib and not args.slugs:
        slugs = CALIB_LOSERS + CALIB_WINNERS + CALIB_OWNER_FAULTS
    elif args.slugs:
        slugs = args.slugs
    else:
        # Auto-discover from dir
        pattern = re.compile(rf'^{re.escape(args.arm)}-(.+)-[12][a-z]+\.png$')
        found = set()
        for f in os.listdir(screenshot_dir):
            m = pattern.match(f)
            if m:
                found.add(m.group(1))
        slugs = sorted(found)

    if not slugs:
        print(f"No slugs found in {screenshot_dir}", file=sys.stderr)
        sys.exit(1)

    workers = min(max(2, cpu_count() - 1), len(slugs), 8)
    print(f"[pixelcheck] auditing {len(slugs)} pages in {screenshot_dir} "
          f"arm={args.arm} workers={workers}", file=sys.stderr)

    # Build per-slug arg tuples (picklable) for multiprocessing
    tasks = [(slug, screenshot_dir, args.arm, args.light_arm, rects_dir)
             for slug in slugs]

    all_results = []
    if workers == 1 or len(slugs) == 1:
        for i, task in enumerate(tasks, 1):
            print(f"  [{i:3d}/{len(slugs)}] {task[0]}", file=sys.stderr, end='\r')
            all_results.extend(_audit_one_task(task))
    else:
        with Pool(workers) as pool:
            for i, results in enumerate(pool.imap_unordered(_audit_one_task, tasks), 1):
                print(f"  [{i:3d}/{len(slugs)}] done", file=sys.stderr, end='\r')
                all_results.extend(results)

    print(f"\n[pixelcheck] done: {len(all_results)} result records", file=sys.stderr)

    if args.calib:
        print_calib_summary(all_results)

    out_json = json.dumps(all_results, indent=2)
    if args.out:
        Path(args.out).write_text(out_json)
        print(f"[pixelcheck] wrote {args.out}", file=sys.stderr)
    else:
        print(out_json)


if __name__ == '__main__':
    main()
