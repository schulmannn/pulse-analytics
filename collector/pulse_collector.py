#!/usr/bin/env python3
"""Pulse Analytics collector.

Runs next to the user's Telegram session, computes metrics through the existing
Telethon implementation and sends only derived JSON to Pulse Analytics.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

VERSION = "1.0.0"
SCHEMA_VERSION = 1
LOG = logging.getLogger("pulse-collector")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def required_config() -> dict[str, str]:
    return {
        "PULSE_API_URL": os.getenv("PULSE_API_URL", "").rstrip("/"),
        "PULSE_API_KEY": os.getenv("PULSE_API_KEY", ""),
        "TG_API_ID": os.getenv("TG_API_ID", ""),
        "TG_API_HASH": os.getenv("TG_API_HASH", ""),
        "TG_SESSION": os.getenv("TG_SESSION", ""),
        "TG_CHANNEL": os.getenv("TG_CHANNEL", ""),
    }


def validate_config(needs_telegram: bool = True) -> dict[str, str]:
    config = required_config()
    required = ["PULSE_API_URL", "PULSE_API_KEY"]
    if needs_telegram:
        required += ["TG_API_ID", "TG_API_HASH", "TG_SESSION", "TG_CHANNEL"]
    missing = [key for key in required if not config[key]]
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))
    return config


class DeliveryQueue:
    def __init__(self, state_dir: Path):
        state_dir.mkdir(parents=True, exist_ok=True)
        self.path = state_dir / "queue.sqlite3"
        self.db = sqlite3.connect(self.path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            """
            CREATE TABLE IF NOT EXISTS deliveries (
              ingest_id TEXT PRIMARY KEY,
              payload TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              next_attempt REAL NOT NULL DEFAULT 0,
              last_error TEXT,
              created_at TEXT NOT NULL
            )
            """
        )
        self.db.commit()

    def enqueue(self, payload: dict[str, Any]) -> None:
        self.db.execute(
            """INSERT OR IGNORE INTO deliveries
               (ingest_id, payload, created_at) VALUES (?, ?, ?)""",
            (payload["ingest_id"], json.dumps(payload, ensure_ascii=False), utc_now()),
        )
        self.db.commit()

    def due(self, limit: int = 20) -> list[tuple[str, dict[str, Any], int]]:
        rows = self.db.execute(
            """SELECT ingest_id, payload, attempts FROM deliveries
               WHERE next_attempt <= ? ORDER BY created_at LIMIT ?""",
            (time.time(), limit),
        ).fetchall()
        return [(row[0], json.loads(row[1]), row[2]) for row in rows]

    def success(self, ingest_id: str) -> None:
        self.db.execute("DELETE FROM deliveries WHERE ingest_id=?", (ingest_id,))
        self.db.commit()

    def failure(self, ingest_id: str, attempts: int, error: str) -> None:
        next_attempts = attempts + 1
        delay = min(3600, 30 * (2 ** min(next_attempts - 1, 7)))
        delay += random.uniform(0, delay * 0.2)
        self.db.execute(
            """UPDATE deliveries
               SET attempts=?, next_attempt=?, last_error=?
               WHERE ingest_id=?""",
            (next_attempts, time.time() + delay, error[:1000], ingest_id),
        )
        self.db.commit()

    def count(self) -> int:
        return int(self.db.execute("SELECT count(*) FROM deliveries").fetchone()[0])

    def close(self) -> None:
        self.db.close()


def api_request(config: dict[str, str], path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = config["PULSE_API_URL"] + path
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="GET" if payload is None else "POST",
        headers={
            "Authorization": "Bearer " + config["PULSE_API_KEY"],
            "Content-Type": "application/json",
            "User-Agent": f"pulse-collector/{VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Pulse API HTTP {error.code}: {body[:500]}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Pulse API unavailable: {error.reason}") from error


async def collect_payload(include_mentions: bool = False) -> dict[str, Any]:
    # Import only after env validation. mtproto.service reads Telegram config at import time.
    from mtproto import service
    internal_token = service.TEAM_PASS

    LOG.info("Collecting channel metadata")
    channel = await service.get_channel(internal_token)
    LOG.info("Collecting posts and aggregate metrics")
    posts = await service.get_posts(limit=100, offset_id=0, x_internal_token=internal_token)
    views_summary = await service.get_views_summary(limit=100, x_internal_token=internal_token)
    stats = await service.get_stats(internal_token)
    graphs = await service.get_graphs(points=400, x_internal_token=internal_token)
    LOG.info("Collecting post lifecycle")
    try:
        velocity = await service.get_velocity(limit=40, top=12, x_internal_token=internal_token)
    except Exception as error:
        LOG.warning("Velocity is temporarily unavailable: %s", error)
        velocity = {"available": False}
    mentions: list[dict[str, Any]] = []
    if include_mentions:
        LOG.info("Collecting mentions (uses Telegram searchPosts quota)")
        try:
            mention_result = await service.get_mentions(internal_token)
            mentions = mention_result.get("all", []) if isinstance(mention_result, dict) else []
        except Exception as error:
            LOG.warning("Mentions are temporarily unavailable: %s", error)

    return {
        "schema_version": SCHEMA_VERSION,
        "ingest_id": str(uuid.uuid4()),
        "collector_version": VERSION,
        "collected_at": utc_now(),
        "channel": channel,
        "stats": stats,
        "graphs": graphs,
        "views_summary": views_summary,
        "posts": posts.get("posts", []),
        "velocity": velocity,
        "mentions": mentions,
    }


def flush_queue(queue: DeliveryQueue, config: dict[str, str]) -> bool:
    all_ok = True
    for ingest_id, payload, attempts in queue.due():
        try:
            result = api_request(config, "/api/collector/ingest", payload)
            queue.success(ingest_id)
            LOG.info(
                "Delivered ingest_id=%s posts=%s daily=%s duplicate=%s",
                ingest_id,
                result.get("posts"),
                result.get("channel_daily"),
                bool(result.get("duplicate")),
            )
        except Exception as error:  # queue owns retry policy
            all_ok = False
            queue.failure(ingest_id, attempts, str(error))
            LOG.warning("Delivery failed for %s: %s", ingest_id, error)
    return all_ok


async def doctor(config: dict[str, str]) -> None:
    LOG.info("Checking Pulse API compatibility")
    compatibility = api_request(config, "/api/collector/compatibility")
    supported = compatibility.get("supported_schema_versions", [])
    if SCHEMA_VERSION not in supported:
        raise RuntimeError(f"Server does not support collector schema {SCHEMA_VERSION}: {supported}")
    LOG.info("Pulse API OK; channel_id=%s", compatibility.get("channel_id"))

    LOG.info("Checking Telegram session and channel access")
    from mtproto import service

    client = await service.get_client()
    entity = await client.get_entity(os.environ["TG_CHANNEL"])
    LOG.info("Telegram OK; channel=%s", getattr(entity, "title", os.environ["TG_CHANNEL"]))
    stats = await service.get_stats(service.TEAM_PASS)
    if isinstance(stats, dict) and stats.get("available") is False:
        raise RuntimeError(
            "Telegram session can read the channel but cannot read admin statistics: "
            + str(stats.get("error", "unknown error"))
        )
    LOG.info("Telegram admin statistics OK")
    await service.shutdown()


async def run_once(queue: DeliveryQueue, config: dict[str, str], include_mentions: bool) -> bool:
    flush_queue(queue, config)
    payload = await collect_payload(include_mentions=include_mentions)
    queue.enqueue(payload)
    return flush_queue(queue, config)


def state_directory() -> Path:
    configured = os.getenv("COLLECTOR_STATE_DIR", "")
    return Path(configured).expanduser() if configured else Path.home() / ".pulse-collector"


async def async_main(args: argparse.Namespace) -> int:
    config = validate_config(needs_telegram=args.command != "flush")
    queue = DeliveryQueue(state_directory())
    include_mentions = bool(args.mentions or os.getenv("COLLECT_MENTIONS") == "1")

    if args.command == "doctor":
        await doctor(config)
        LOG.info("Doctor completed successfully; queued=%s", queue.count())
        return 0
    if args.command == "flush":
        ok = flush_queue(queue, config)
        LOG.info("Queue flush finished; queued=%s", queue.count())
        return 0 if ok else 1
    if args.command == "once":
        ok = await run_once(queue, config, include_mentions)
        return 0 if ok else 1

    interval = max(900, int(os.getenv("COLLECT_INTERVAL_SECONDS", "21600")))
    while True:
        try:
            await run_once(queue, config, include_mentions)
        except Exception as error:
            LOG.exception("Collection failed: %s", error)
        LOG.info("Next collection in %s seconds; queued=%s", interval, queue.count())
        await asyncio.sleep(interval)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pulse Analytics local Telegram collector")
    parser.add_argument("command", choices=["run", "once", "flush", "doctor"], nargs="?", default="run")
    parser.add_argument(
        "--mentions",
        action="store_true",
        help="Collect brand mentions (consumes the limited Telegram searchPosts quota)",
    )
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        return asyncio.run(async_main(parse_args()))
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        LOG.error("%s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
