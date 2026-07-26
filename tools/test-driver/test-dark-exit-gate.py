#!/usr/bin/env python3
"""Producer tests for the fail-closed dark exit gate."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "tools/test-driver/dark-exit-gate.py"
OWNER_URLS = {
    "https://www.zdnet.com/home-and-office/networking/spacex-wants-to-launch-100000-more-starlink-satellites/",
    "https://pvk.ca/Blog/2019/01/09/preemption-is-gc-for-memory-reordering/",
    "https://css-tricks.com/",
    "https://css-tricks.com/get-ready-for-the-powerful-css-border-shape-property/",
    "https://www.youtube.com/watch?v=jfKfPfyJRdk",
    "https://en.wikipedia.org/wiki/Arthur_Tedder,_1st_Baron_Tedder",
}
CANARY_URLS = {"https://redis.io/", "https://github.com/", "https://without.boats/"}
RECURRING_URLS = {
    "https://azure.microsoft.com/",
    "https://www.bbc.com/",
    "https://cloud.google.com/",
    "https://www.cnn.com/",
    "https://www.economist.com/",
    "https://www.fifa.com/",
    "https://www.imdb.com/",
    "https://kubernetes.io/",
    "https://www.linkedin.com/",
    "https://news.microsoft.com/",
    "https://nodejs.org/",
    "https://redis.io/",
    "https://stackoverflow.com/",
    "https://stripe.com/",
    "https://techcrunch.com/",
    "https://www.theguardian.com/",
}


class DarkExitGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "configs").mkdir()
        shutil.copy(ROOT / "configs/dark-mode-exit-corpus.txt", self.root / "configs/dark-mode-exit-corpus.txt")
        corpus = self.root / "configs/dark-mode-exit-corpus.txt"
        policy = json.loads((ROOT / "configs/dark-mode-exit-policy.json").read_text())
        policy["corpus_sha256"] = hashlib.sha256(corpus.read_bytes()).hexdigest()
        self.policy = self.root / "configs/dark-mode-exit-policy.json"
        self.policy.write_text(json.dumps(policy), encoding="utf-8")
        self.entries = [line.split("|") for line in corpus.read_text().splitlines() if line and not line.startswith("#")]

    def tearDown(self):
        self.tmp.cleanup()

    def clean_records(self):
        records = []
        for ident, _category, _severity, url in self.entries:
            for position in ("top", "mid"):
                arm = {"status": "ok", "url": url, "content_sha256": f"sha-{ident}-{position}", "quarantined": False, "error": None, "escape_hatch": False}
                records.append({"id": ident, "position": position, "candidate": arm, "fallback": dict(arm), "same_content": True, "sentinels": {"candidate": True, "fallback": True}, "escape_hatch": False})
        return records

    def test_corpus_has_exact_evidence_categories(self):
        categories = {}
        for _ident, category, _severity, url in self.entries:
            categories.setdefault(category, set()).add(url)
        self.assertEqual(categories, {
            "owner": OWNER_URLS,
            "canary": CANARY_URLS,
            "recurring-loss": RECURRING_URLS,
        })
        self.assertEqual(len(self.entries), 25)
        self.assertEqual(len(CANARY_URLS), 3)
        self.assertIn("https://redis.io/", CANARY_URLS)
        self.assertIn("https://redis.io/", RECURRING_URLS)

    def test_committed_policy_hash_and_counts(self):
        policy = json.loads((ROOT / "configs/dark-mode-exit-policy.json").read_text())
        corpus = ROOT / "configs/dark-mode-exit-corpus.txt"
        self.assertEqual(policy["corpus_sha256"], hashlib.sha256(corpus.read_bytes()).hexdigest())
        self.assertEqual(policy["required_classes"], {
            "owner": len(OWNER_URLS),
            "canary": len(CANARY_URLS),
            "recurring-loss": len(RECURRING_URLS),
        })

    def run_gate(self, records):
        path = self.root / "records.jsonl"
        path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        return subprocess.run([sys.executable, str(GATE), "--policy", str(self.policy), "--records", str(path)], text=True, capture_output=True)

    def test_clean_corpus_passes(self):
        result = self.run_gate(self.clean_records())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("50 exact candidate/fallback top+mid pairs", result.stdout)

    def test_injected_failure_paths_fail_closed(self):
        mutations = {
            "missing pair": lambda r: r.pop(),
            "candidate error": lambda r: r[0]["candidate"].update(error="navigation failed"),
            "quarantine": lambda r: r[0]["fallback"].update(quarantined=True),
            "content mismatch": lambda r: r[0].update(same_content=False),
            "digest mismatch": lambda r: r[0]["fallback"].update(content_sha256="different"),
            "sentinel": lambda r: r[0].update(sentinels={"candidate": False, "fallback": True}),
            "escape": lambda r: r[0]["candidate"].update(escape_hatch=True),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                records = self.clean_records()
                mutate(records)
                result = self.run_gate(records)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("FAIL", result.stderr)

    def test_policy_reset_and_corpus_drift_fail_closed(self):
        policy = json.loads(self.policy.read_text())
        policy["allow_reset"] = True
        self.policy.write_text(json.dumps(policy), encoding="utf-8")
        self.assertNotEqual(self.run_gate(self.clean_records()).returncode, 0)
        policy["allow_reset"] = False
        self.policy.write_text(json.dumps(policy), encoding="utf-8")
        with (self.root / "configs/dark-mode-exit-corpus.txt").open("a", encoding="utf-8") as handle:
            handle.write("\n# drift")
        self.assertNotEqual(self.run_gate(self.clean_records()).returncode, 0)


if __name__ == "__main__":
    unittest.main()
