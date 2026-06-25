# Pulse Collector

Collector runs with your Telegram credentials on your own machine and sends only
derived analytics to Pulse Analytics. `TG_SESSION`, `TG_API_HASH` and phone data
are never sent to the SaaS.

Required environment variables:

```env
PULSE_API_URL=https://your-pulse-domain.example
PULSE_API_KEY=pa_...
TG_API_ID=123456
TG_API_HASH=...
TG_SESSION=...
TG_CHANNEL=@your_channel
```

Commands:

```bash
python collector/pulse_collector.py doctor
python collector/pulse_collector.py once
python collector/pulse_collector.py run
python collector/pulse_collector.py flush
```

`run` collects every six hours by default. Set `COLLECT_INTERVAL_SECONDS` to
change the interval (minimum 15 minutes). Failed deliveries remain in
`~/.pulse-collector/queue.sqlite3` and retry with exponential backoff.

Mentions are disabled by default because Telegram limits `searchPosts`. Enable
them explicitly with `--mentions` or `COLLECT_MENTIONS=1`.
