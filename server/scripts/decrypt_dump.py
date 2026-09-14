"""Decrypt a raw MongoDB export (mongoexport JSON) offline.

Any string value that starts with "enc:v1:" is replaced by its plaintext; every
other value is left untouched. Requires only the encryption key + `cryptography`.

Usage:
    # 1) export a collection
    mongoexport --uri "<MONGO_URI>" --collection users --out users.json --jsonArray
    # 2) decrypt it (key from env or --key)
    set DATA_ENCRYPTION_KEY=your-base64-key         # Windows (use export on *nix)
    python scripts/decrypt_dump.py users.json --out users_plain.json

See extras/guide.txt for the full recovery walkthrough.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

PREFIX = "enc:v1:"


def main() -> int:
    ap = argparse.ArgumentParser(description="Decrypt a mongoexport JSON dump.")
    ap.add_argument("input", help="Path to the exported JSON file")
    ap.add_argument("--out", default="decrypted.json", help="Output path")
    ap.add_argument("--key", default=os.environ.get("DATA_ENCRYPTION_KEY", ""),
                    help="Fernet key (else read DATA_ENCRYPTION_KEY env)")
    args = ap.parse_args()

    if not args.key:
        print("ERROR: provide the key via --key or DATA_ENCRYPTION_KEY.",
              file=sys.stderr)
        return 2
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        print("ERROR: pip install cryptography", file=sys.stderr)
        return 2

    fernet = Fernet(args.key.encode())

    def dec(v):
        if isinstance(v, str) and v.startswith(PREFIX):
            try:
                return fernet.decrypt(v[len(PREFIX):].encode()).decode()
            except Exception:  # noqa: BLE001
                return v
        if isinstance(v, list):
            return [dec(x) for x in v]
        if isinstance(v, dict):
            return {k: dec(x) for k, x in v.items()}
        return v

    with open(args.input, encoding="utf-8") as fh:
        data = json.load(fh)
    out = dec(data)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False, default=str)
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
