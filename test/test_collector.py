import argparse
import asyncio
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from collector import pulse_collector
from collector.pulse_collector import ApiHttpError, DeliveryQueue

CONFIG = {"PULSE_API_URL": "http://api.test", "PULSE_API_KEY": "key"}


class _StopLoop(Exception):
    """Breaks the otherwise-eternal run loop once the recheck cadence has been observed."""


def row_status(queue: DeliveryQueue, ingest_id: str):
    row = queue.db.execute(
        "SELECT status FROM deliveries WHERE ingest_id=?", (ingest_id,)
    ).fetchone()
    return row[0] if row else None


class DeliveryQueueTests(unittest.TestCase):
    def test_payload_survives_restart_until_success(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            payload = {"ingest_id": "test-ingest-123", "schema_version": 1}
            first = DeliveryQueue(state)
            first.enqueue(payload)
            self.assertEqual(first.count(), 1)
            first.close()

            reopened = DeliveryQueue(state)
            due = reopened.due()
            self.assertEqual(due[0][0], payload["ingest_id"])
            self.assertEqual(due[0][1], payload)
            reopened.success(payload["ingest_id"])
            self.assertEqual(reopened.count(), 0)
            reopened.close()

    def test_failed_delivery_is_delayed(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = DeliveryQueue(Path(directory))
            payload = {"ingest_id": "test-ingest-456", "schema_version": 1}
            queue.enqueue(payload)
            ingest_id, _, attempts = queue.due()[0]
            queue.failure(ingest_id, attempts, "network down")
            self.assertEqual(queue.count(), 1)
            self.assertEqual(queue.due(), [])
            queue.close()

    def test_dead_letter_is_excluded_from_due_and_count(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = DeliveryQueue(Path(directory))
            queue.enqueue({"ingest_id": "dead-1", "schema_version": 1})
            queue.dead("dead-1", "HTTP 400")
            self.assertEqual(queue.due(), [])
            self.assertEqual(queue.count(), 0)
            self.assertEqual(row_status(queue, "dead-1"), "dead")  # kept for inspection
            queue.close()

    def test_legacy_queue_without_status_column_is_upgraded(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            legacy = sqlite3.connect(state / "queue.sqlite3")
            legacy.execute(
                """CREATE TABLE deliveries (
                     ingest_id TEXT PRIMARY KEY,
                     payload TEXT NOT NULL,
                     attempts INTEGER NOT NULL DEFAULT 0,
                     next_attempt REAL NOT NULL DEFAULT 0,
                     last_error TEXT,
                     created_at TEXT NOT NULL
                   )"""
            )
            legacy.execute(
                "INSERT INTO deliveries (ingest_id, payload, created_at)"
                " VALUES ('old-1', '{\"ingest_id\": \"old-1\"}', 'now')"
            )
            legacy.commit()
            legacy.close()

            queue = DeliveryQueue(state)  # must ALTER the table in place
            self.assertEqual(queue.count(), 1)
            self.assertEqual(queue.due()[0][0], "old-1")
            self.assertEqual(row_status(queue, "old-1"), "pending")
            queue.close()


class FlushQueueRetryPolicyTests(unittest.TestCase):
    def flush(self, queue):
        return asyncio.run(pulse_collector.flush_queue(queue, CONFIG))

    def test_poison_4xx_is_dead_lettered_immediately(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = DeliveryQueue(Path(directory))
            queue.enqueue({"ingest_id": "poison-1", "schema_version": 1})
            error = ApiHttpError(400, "Atlavue API HTTP 400: bad payload")
            with mock.patch.object(pulse_collector, "api_request", side_effect=error):
                self.assertFalse(self.flush(queue))
            self.assertEqual(row_status(queue, "poison-1"), "dead")
            self.assertEqual(queue.due(), [])
            self.assertEqual(queue.count(), 0)
            queue.close()

    def test_retryable_http_statuses_stay_queued(self):
        # 401/403 — проблема КЛЮЧА (ротация PULSE_API_KEY, деплой-блип), не payload'а:
        # dead-letter с первой попытки терял бы все накопленные метрики безвозвратно.
        for code in (401, 403, 408, 429, 500):
            with tempfile.TemporaryDirectory() as directory:
                queue = DeliveryQueue(Path(directory))
                queue.enqueue({"ingest_id": "retry-1", "schema_version": 1})
                error = ApiHttpError(code, f"Atlavue API HTTP {code}: later")
                with mock.patch.object(pulse_collector, "api_request", side_effect=error):
                    self.assertFalse(self.flush(queue))
                self.assertEqual(row_status(queue, "retry-1"), "pending", code)
                self.assertEqual(queue.count(), 1, code)
                self.assertEqual(queue.due(), [], code)  # delayed, not dropped
                queue.close()

    def test_attempts_cap_dead_letters_transient_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = DeliveryQueue(Path(directory))
            queue.enqueue({"ingest_id": "tired-1", "schema_version": 1})
            queue.db.execute(
                "UPDATE deliveries SET attempts=? WHERE ingest_id='tired-1'",
                (pulse_collector.MAX_DELIVERY_ATTEMPTS - 1,),
            )
            queue.db.commit()
            with mock.patch.object(
                pulse_collector, "api_request", side_effect=RuntimeError("network down")
            ):
                self.assertFalse(self.flush(queue))
            self.assertEqual(row_status(queue, "tired-1"), "dead")
            self.assertEqual(queue.count(), 0)
            queue.close()

    def test_successful_flush_removes_row(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = DeliveryQueue(Path(directory))
            queue.enqueue({"ingest_id": "ok-1", "schema_version": 1})
            with mock.patch.object(
                pulse_collector, "api_request", return_value={"ok": True, "duplicate": False}
            ):
                self.assertTrue(self.flush(queue))
            self.assertEqual(queue.count(), 0)
            self.assertIsNone(row_status(queue, "ok-1"))
            queue.close()


class RunLoopCompatibilityTests(unittest.TestCase):
    """The eternal `run` re-verifies /api/collector/compatibility (doctor's check):
    an incompatible schema stops the process loudly instead of silently dead-lettering
    every collection; a transient failure of the check itself never kills the loop."""

    def check(self):
        return asyncio.run(pulse_collector.ensure_compatibility(CONFIG))

    def test_supported_schema_keeps_running(self):
        with mock.patch.object(
            pulse_collector,
            "api_request",
            return_value={"supported_schema_versions": [pulse_collector.SCHEMA_VERSION]},
        ):
            self.check()  # must not raise

    def test_incompatible_schema_stops_loudly_with_exit_code_2(self):
        with mock.patch.object(
            pulse_collector,
            "api_request",
            return_value={"supported_schema_versions": [999]},
        ):
            with self.assertLogs("pulse-collector", level="ERROR") as logs:
                with self.assertRaises(SystemExit) as stop:
                    self.check()
        self.assertEqual(stop.exception.code, 2)
        self.assertTrue(any("Update the collector" in line for line in logs.output))

    def test_transient_check_failure_does_not_stop_the_loop(self):
        with mock.patch.object(
            pulse_collector,
            "api_request",
            side_effect=RuntimeError("Atlavue API unavailable: connection refused"),
        ):
            with self.assertLogs("pulse-collector", level="WARNING"):
                self.check()  # must not raise

    def test_run_loop_rechecks_on_first_pass_and_every_20th(self):
        recheck_at: list[int] = []
        runs = 0

        async def fake_ensure(config):
            recheck_at.append(runs)

        async def fake_run_once(queue, config, include_mentions):
            nonlocal runs
            runs += 1

        async def fake_sleep(seconds):
            if runs > 2 * pulse_collector.COMPATIBILITY_RECHECK_PASSES:
                raise _StopLoop()

        with tempfile.TemporaryDirectory() as directory:
            env = {
                "COLLECTOR_STATE_DIR": directory,
                "PULSE_API_URL": "http://api.test",
                "PULSE_API_KEY": "key",
                "TG_API_ID": "1",
                "TG_API_HASH": "hash",
                "TG_SESSION": "session",
                "TG_CHANNEL": "@channel",
            }
            args = argparse.Namespace(command="run", mentions=False)
            with mock.patch.dict(os.environ, env), \
                    mock.patch.object(pulse_collector, "ensure_compatibility", fake_ensure), \
                    mock.patch.object(pulse_collector, "run_once", fake_run_once), \
                    mock.patch.object(pulse_collector.asyncio, "sleep", fake_sleep):
                with self.assertRaises(_StopLoop):
                    asyncio.run(pulse_collector.async_main(args))
        self.assertEqual(recheck_at, [0, 20, 40])


if __name__ == "__main__":
    unittest.main()
