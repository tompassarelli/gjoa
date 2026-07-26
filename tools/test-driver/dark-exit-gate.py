#!/usr/bin/env python3
"""Fail-closed acceptance gate for the dark-mode exit corpus.

The compositor runner emits one JSON object per corpus id and viewport position.
Each object is a candidate/fallback pair: both arms must have rendered the exact
requested URL, the same page identity, active sentinels, and no escape hatch.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path


def fail(message):
    print(f"dark-exit-gate: FAIL: {message}", file=sys.stderr)
    return False


def load_json(path, label):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} unreadable: {exc}") from exc


def load_corpus(path):
    entries = []
    seen = set()
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ValueError(f"corpus unreadable: {exc}") from exc
    for line_no, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split("|")
        if len(fields) != 4:
            raise ValueError(f"corpus line {line_no}: expected id|class|severity|url")
        ident, category, severity, url = fields
        if not ident or ident in seen or not url.startswith(("https://", "http://")):
            raise ValueError(f"corpus line {line_no}: malformed or duplicate entry")
        try:
            severity = int(severity)
        except ValueError as exc:
            raise ValueError(f"corpus line {line_no}: severity is not an integer") from exc
        seen.add(ident)
        entries.append({"id": ident, "class": category, "severity": severity, "url": url})
    return entries


def load_records(path):
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ValueError(f"records unreadable: {exc}") from exc
    records = []
    for line_no, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"records line {line_no}: invalid JSON") from exc
        if not isinstance(record, dict):
            raise ValueError(f"records line {line_no}: object required")
        records.append(record)
    return records


def validate(policy_path, records_path):
    policy = load_json(policy_path, "policy")
    required_policy = {"schema", "corpus", "corpus_sha256", "severity", "allow_reset", "required_classes", "positions"}
    if set(policy) != required_policy:
        return fail("policy keys are not exact")
    if policy["schema"] != "gjoa.dark-exit-policy/v1" or policy["severity"] != 1 or policy["allow_reset"] is not False:
        return fail("policy must be severity-1 with reset forbidden")
    if policy["positions"] != ["top", "mid"]:
        return fail("policy must require exact top+mid positions")
    corpus_path = Path(policy_path).parent.parent / policy["corpus"] if not Path(policy["corpus"]).is_absolute() else Path(policy["corpus"])
    # Policy paths are repo-root relative; the default policy sits in configs/.
    if not corpus_path.exists():
        corpus_path = Path(policy["corpus"])
    try:
        digest = hashlib.sha256(corpus_path.read_bytes()).hexdigest()
        corpus = load_corpus(corpus_path)
    except ValueError as exc:
        return fail(str(exc))
    if digest != policy["corpus_sha256"]:
        return fail("corpus content hash differs from committed policy")
    counts = {category: sum(entry["class"] == category for entry in corpus) for category in policy["required_classes"]}
    if counts != policy["required_classes"] or any(entry["severity"] != 1 for entry in corpus):
        return fail("corpus does not contain the committed severity-1 class counts")
    try:
        records = load_records(records_path)
    except ValueError as exc:
        return fail(str(exc))
    expected = {(entry["id"], position): entry for entry in corpus for position in policy["positions"]}
    actual = {}
    for record in records:
        if set(record) != {"id", "position", "candidate", "fallback", "same_content", "sentinels", "escape_hatch"}:
            return fail("record keys are not exact")
        key = (record.get("id"), record.get("position"))
        if key not in expected or key in actual:
            return fail(f"unexpected or duplicate pair {key}")
        actual[key] = record
    if set(actual) != set(expected):
        return fail(f"pair count mismatch: expected {len(expected)}, got {len(actual)}")
    for key, entry in expected.items():
        record = actual[key]
        if record["same_content"] is not True or record["escape_hatch"] is not False:
            return fail(f"{key}: content mismatch or escape hatch")
        if record["sentinels"] != {"candidate": True, "fallback": True}:
            return fail(f"{key}: sentinel failure")
        for arm_name in ("candidate", "fallback"):
            arm = record[arm_name]
            if set(arm) != {"status", "url", "content_sha256", "quarantined", "error", "escape_hatch"}:
                return fail(f"{key}: {arm_name} keys are not exact")
            if (arm["status"] != "ok" or arm["url"] != entry["url"] or
                    not isinstance(arm["content_sha256"], str) or not arm["content_sha256"] or
                    arm["quarantined"] is not False or arm["error"] is not None or arm["escape_hatch"] is not False):
                return fail(f"{key}: {arm_name} failed, quarantined, escaped, or rendered wrong content")
        if record["candidate"]["content_sha256"] != record["fallback"]["content_sha256"]:
            return fail(f"{key}: candidate and fallback content digests differ")
    print(f"dark-exit-gate: PASS: {len(expected)} exact candidate/fallback top+mid pairs")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", default="configs/dark-mode-exit-policy.json")
    parser.add_argument("--records", required=True, help="JSONL output from the real compositor runner")
    args = parser.parse_args()
    try:
        return 0 if validate(args.policy, args.records) else 1
    except ValueError as exc:
        print(f"dark-exit-gate: FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
