#!/usr/bin/env python3
"""
check-iopackage-i18n-sync.py — Drift-Schutz zwischen io-package.json:instanceObjects
und src/lib/i18n-states.ts.

Hintergrund: in v1.31.x sind zwei Truncation-Bugs aufgetreten (info.serverUuid.desc.en
und global.manualUrl.common.name.* in 11 Sprachen) weil die Strings in
io-package.json:instanceObjects per Hand gepflegt werden, während dieselben
Strings auch in src/lib/i18n-states.ts:STATE_NAMES/STATE_DESCS leben. Beim
Editieren der einen Quelle bleibt die andere stehen.

Dieses Skript validiert dass die 11 Sprach-Varianten in beiden Quellen identisch
sind und scheitert (exit 1) bei Drift. Aufgerufen als Pre-commit-Hook im
release-Workflow via .releaseconfig.json:exec.before_commit.

Aufruf:
    python3 scripts/check-iopackage-i18n-sync.py      # aus Adapter-Root
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"]

# Mapping: io-package.json instanceObjects._id  →  i18n-states.ts STATE_NAMES-Key
NAME_MAPPING = {
    "info.connection": "connection",
    "info.serverUuid": "serverUuid",
    "info.refresh_urls": "refreshUrls",
    "clients": "clients",
    "global": "global",
    "global.enabled": "globalEnabled",
    "global.mode": "globalMode",
    "global.manualUrl": "globalManualUrl",
}

# Mapping: io-package.json instanceObjects._id  →  i18n-states.ts STATE_DESCS-Key
DESC_MAPPING = {
    "info.serverUuid": "serverUuidDesc",
    "info.refresh_urls": "refreshUrlsDesc",
}


def parse_ts_dict(text: str, dict_name: str) -> dict[str, dict[str, str]]:
    """Parse `export const <dict_name>: Record<string, StateName> = { ... };`.

    Returns mapping {top_level_key: {lang_code: value}}.
    """
    # Block zwischen `export const NAME ... = {` und der schließenden `^};` Zeile
    block_match = re.search(
        rf"export const {dict_name}[^=]*=\s*\{{(.*?)^\}};",
        text,
        re.DOTALL | re.MULTILINE,
    )
    if not block_match:
        return {}
    block = block_match.group(1)

    result: dict[str, dict[str, str]] = {}
    # Top-level keys with 4-space indent — quoted oder nicht. Block bis matching `^    },?`
    for key_match in re.finditer(
        r"^    ['\"]?([a-zA-Z][a-zA-Z0-9-_]*)['\"]?\s*:\s*\{(.*?)^    \},?",
        block,
        re.DOTALL | re.MULTILINE,
    ):
        key = key_match.group(1)
        inner = key_match.group(2)
        langs: dict[str, str] = {}
        # Each lang line: "        en: 'value'," oder "        'zh-cn': 'value',"
        # Auch double-quoted Values, die single-quotes enthalten:
        # "        en: \"Global manual URL (used when mode='manual')\","
        for lang_match in re.finditer(
            r"^\s*['\"]?([a-z]{2}(?:-[a-z]{2})?)['\"]?\s*:\s*(['\"])(.*?)\2\s*,?\s*$",
            inner,
            re.MULTILINE,
        ):
            lang = lang_match.group(1)
            val = lang_match.group(3)
            if lang in LANGS:
                langs[lang] = val
        if langs:
            result[key] = langs
    return result


def check_field(
    instance_objects: dict[str, dict],
    ts_dict: dict[str, dict[str, str]],
    mapping: dict[str, str],
    field_name: str,
) -> int:
    """Compare `common.<field_name>` translation objects against the TS dict.

    Returns the number of drift entries found.
    """
    drift_count = 0
    for io_id, i18n_key in mapping.items():
        if io_id not in instance_objects:
            print(f"WARN: instanceObjects missing _id={io_id}")
            continue
        if i18n_key not in ts_dict:
            print(f"ERROR: i18n-states.ts missing key={i18n_key} (mapped for {io_id})")
            drift_count += 1
            continue
        io_obj = instance_objects[io_id]["common"].get(field_name)
        ts_obj = ts_dict[i18n_key]
        if not isinstance(io_obj, dict):
            print(f"ERROR: io-package {io_id}.common.{field_name} is not a translation object")
            drift_count += 1
            continue
        for lang in LANGS:
            io_val = io_obj.get(lang, "")
            ts_val = ts_obj.get(lang, "")
            if io_val != ts_val:
                print(f"DRIFT {field_name}[{io_id}/{lang}]:")
                print(f"  io-package: {io_val!r}")
                print(f"  i18n-states: {ts_val!r}")
                drift_count += 1
    return drift_count


def main() -> int:
    # Skript liegt unter <adapter>/scripts/, Adapter-Root ist parent
    repo_root = Path(__file__).resolve().parent.parent
    iopkg_path = repo_root / "io-package.json"
    i18n_path = repo_root / "src" / "lib" / "i18n-states.ts"

    if not iopkg_path.is_file():
        print(f"ERROR: io-package.json not found at {iopkg_path}")
        return 1
    if not i18n_path.is_file():
        print(f"ERROR: i18n-states.ts not found at {i18n_path}")
        return 1

    iopkg = json.loads(iopkg_path.read_text(encoding="utf-8"))
    i18n_text = i18n_path.read_text(encoding="utf-8")

    state_names = parse_ts_dict(i18n_text, "STATE_NAMES")
    state_descs = parse_ts_dict(i18n_text, "STATE_DESCS")

    if not state_names:
        print("ERROR: could not parse STATE_NAMES from i18n-states.ts — Skript-Pattern angepasst werden")
        return 1

    instance_objects = {x["_id"]: x for x in iopkg.get("instanceObjects", [])}

    drift_count = 0
    drift_count += check_field(instance_objects, state_names, NAME_MAPPING, "name")
    drift_count += check_field(instance_objects, state_descs, DESC_MAPPING, "desc")

    if drift_count > 0:
        print(f"\nFAIL: {drift_count} drift(s) zwischen io-package.json und i18n-states.ts")
        print("Fix: io-package.json:instanceObjects mit den Werten aus src/lib/i18n-states.ts synchronisieren.")
        return 1

    total_checks = (len(NAME_MAPPING) + len(DESC_MAPPING)) * len(LANGS)
    print(f"OK: io-package.json ↔ i18n-states.ts in sync ({total_checks} string-compares)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
