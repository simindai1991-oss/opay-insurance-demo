"""JSON file store for demo tables."""
from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SEED_DIR = ROOT / "data" / "seed"
STORE_DIR = ROOT / "data" / "store"

TABLES = [
    "meta",
    "insurance_plan_config",
    "user_insured_person",
    "enrollee_profile",
    "policy_master",
    "policy_status_timeline",
    "policy_billing_schedule",
    "policy_payment_transaction",
    "hospitals",
    "plan_cover_config",
]

_lock = threading.RLock()


def _path(name: str) -> Path:
    return STORE_DIR / f"{name}.json"


def ensure_store() -> None:
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    for name in TABLES:
        dest = _path(name)
        if not dest.exists():
            src = SEED_DIR / f"{name}.json"
            if src.exists():
                shutil.copy2(src, dest)
            else:
                dest.write_text("[]" if name != "meta" else "{}", encoding="utf-8")


def reset_store() -> None:
    with _lock:
        if STORE_DIR.exists():
            shutil.rmtree(STORE_DIR)
        ensure_store()


def read_table(name: str) -> Any:
    ensure_store()
    with _lock:
        return json.loads(_path(name).read_text(encoding="utf-8"))


def write_table(name: str, data: Any) -> None:
    ensure_store()
    with _lock:
        _path(name).write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def next_id(prefix: str) -> str:
    import time
    import random

    return f"{prefix}_{int(time.time() * 1000)}_{random.randint(100, 999)}"
