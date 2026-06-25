import tempfile
import unittest
from pathlib import Path

from collector.pulse_collector import DeliveryQueue


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


if __name__ == "__main__":
    unittest.main()
