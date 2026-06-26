# Pulse Collector

Collector runs with your Telegram credentials on your own machine and sends only
derived analytics to Pulse Analytics. `TG_SESSION`, `TG_API_HASH` and phone data
are never sent to the SaaS.

## First-time setup: QR login

Run the `login` command once to authenticate and save a local session file.
You do **not** need to provide `TG_SESSION` manually.

```bash
python collector/pulse_collector.py login
```

A QR code will appear in your terminal. Open Telegram on your phone, go to
**Settings -> Devices -> Link Desktop Device**, and scan the code.
If two-factor authentication is enabled you will be prompted for the password once.

The session is saved to `~/.pulse-collector/session.txt` (permissions 600).
Subsequent `once`/`run`/`doctor` invocations load it automatically.

## Environment variables

```env
PULSE_API_URL=https://your-pulse-domain.example
PULSE_API_KEY=pa_...
TG_API_ID=123456
TG_API_HASH=...
TG_CHANNEL=@your_channel
# TG_SESSION is optional -- it is loaded from ~/.pulse-collector/session.txt
# after running `login`. Set it explicitly only if you have a pre-existing
# StringSession string and want to skip the login step.
```

## Commands

```bash
# First-time auth (shows QR code, saves session locally)
python collector/pulse_collector.py login

# Verify connectivity
python collector/pulse_collector.py doctor

# Collect once
python collector/pulse_collector.py once

# Collect every 6 hours (default)
python collector/pulse_collector.py run

# Retry failed deliveries
python collector/pulse_collector.py flush
```

`run` collects every six hours by default. Set `COLLECT_INTERVAL_SECONDS` to
change the interval (minimum 15 minutes). Failed deliveries remain in
`~/.pulse-collector/queue.sqlite3` and retry with exponential backoff.

Mentions are disabled by default because Telegram limits `searchPosts`. Enable
them explicitly with `--mentions` or `COLLECT_MENTIONS=1`.

## Dependencies

```bash
pip install -r collector/requirements.txt
```

See `collector/requirements.txt` for the full list (`telethon`, `qrcode`).
