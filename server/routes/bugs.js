'use strict';

const crypto = require('crypto');
const notionCrash = require('../lib/notion_crash');
const { canDispatchBugKind, sanitizeForPrompt } = require('../lib/bugfix_gate');

function registerBugsRoutes({
  app, express, db, rateLimit, requireAuth, requireSuper, fetchWithTimeout, AUTH_SECRET,
}) {
  // ════════════════════════════════════════════════════════════════
  //  БАГ-ТРЕКЕР (Postgres)
  // ════════════════════════════════════════════════════════════════
  app.post('/api/bugs', requireAuth, requireSuper, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена — баги негде сохранять' });
    const text = ((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Опиши баг' });
    try {
      const bug = await db.createBug({ text, severity: req.body.severity, context: req.body.context, kind: req.body.kind });
      res.json(bug);
    } catch (e) { next(e); }
  });

  app.get('/api/bugs', requireAuth, requireSuper, async (req, res) => {
    try {
      res.json({ enabled: db.enabled, statuses: db.BUG_STATUSES, kinds: db.BUG_KINDS, bugs: await db.listBugs(req.query.status) });
    } catch (e) { res.status(200).json({ enabled: db.enabled, bugs: [], error: e.message }); }
  });

  app.patch('/api/bugs/:id', requireAuth, requireSuper, async (req, res) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const bug = await db.updateBug(id, (req.body && req.body.status));
      if (!bug) return res.status(404).json({ error: 'not found' });
      res.json(bug);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/bugs/:id', requireAuth, requireSuper, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try { await db.deleteBug(id); res.json({ ok: true }); }
    catch (e) { next(e); }
  });

  // ── Client render-crash telemetry (P0) ──
  // The widget + app error boundaries POST a caught render crash here so it is diagnosable in the
  // admin Bugs surface (kind='crash') by its trace id — not just a lost console line. Any AUTHENTICATED
  // user reports THEIR OWN crashes (no superuser gate — the point is to catch real users' crashes), so
  // it is tightly rate limited, every field is length-capped, the uid is HASHED (not stored raw), and
  // the server stamps its own deployed commit. Reporting must never fail loudly: storage errors are
  // swallowed and acked, so a crash report can't itself become a crash.
  const crashLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    // requireAuth runs BEFORE this limiter, so req.user is always set (no raw-ip fallback needed).
    keyGenerator: (req) => `crash:u${req.user.uid}`,
    message: { error: 'Слишком много отчётов об ошибках.' },
  });
  const SERVER_COMMIT = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev').slice(0, 7);
  const hashUid = (uid) => crypto.createHash('sha256').update(`${uid}:${AUTH_SECRET}`).digest('hex').slice(0, 12);

  // Client-crash → dedup ledger (+ optional Notion card). Always upserts the signature ledger when the
  // DB is on (queryable crash counts); posts/updates a Notion card only when NOTION_TOKEN + NOTION_CRASH_DB
  // are set. One card per unique signature; repeats bump the counter, throttled to ≤1 Notion write /
  // 5 min per signature so a broken deploy can't hammer the Notion API. Fully fire-and-forget.
  const NOTION_CRASH_THROTTLE_MS = 5 * 60 * 1000;
  async function crashSinkToNotion(f) {
    const sig = await db.upsertCrashSignature(f);
    if (!sig || !notionCrash.enabled) return;
    if (sig.isNew) {
      const pageId = await notionCrash.createCrashCard({ ...f, count: sig.count });
      if (pageId) await db.setCrashNotionPage(f.signature, pageId);
    } else if (sig.notionPageId) {
      const last = sig.lastNotified ? Date.parse(sig.lastNotified) : 0;
      if (Date.now() - last >= NOTION_CRASH_THROTTLE_MS) {
        await notionCrash.updateCrashCard(sig.notionPageId, { count: sig.count, at: f.at, traceId: f.traceId });
        await db.touchCrashNotified(f.signature);
      }
    }
  }

  app.post('/api/client-errors', requireAuth, crashLimiter, async (req, res) => {
    try {
      const b = req.body || {};
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
      const traceId = str(b.traceId, 40) || '';
      const name = str(b.name, 120) || 'Error';
      const message = str(b.message, 500) || '';
      const scope = b.scope === 'app' || b.scope === 'global' ? b.scope : 'widget';
      const route = str(b.route, 200) || '';
      const widgetId = str(b.widgetId, 120);
      const label = str(b.label, 160);
      // Trace id in the VISIBLE text (not just the context JSON) so an admin finds a crash by the id
      // the user quotes straight from the Bugs list — no need to expand each row's context.
      const text = `[crash:${scope}] ${name}: ${message} · ${traceId}`.slice(0, 300);
      const context = JSON.stringify({
        traceId, scope, route, widgetId, label,
        componentStack: str(b.componentStack, 6000),
        uidHash: hashUid(req.user.uid),
        commit: SERVER_COMMIT,
        ua: str(req.headers['user-agent'], 200),
        at: new Date().toISOString(),
      });
      if (db.enabled) {
        const row = await db.createCrash({ text, context });
        // Dedup ledger + Notion card (fire-and-forget — never delays or breaks the crash ack).
        crashSinkToNotion({
          signature: crypto.createHash('sha256').update(`${scope}|${name}|${message}|${route}|${SERVER_COMMIT}`).digest('hex').slice(0, 16),
          scope, name, message, route, widgetId, label, traceId, commit: SERVER_COMMIT,
          stack: str(b.componentStack, 4000), at: new Date().toISOString(),
        }).catch(() => {});
        return res.json({ ok: true, id: row ? row.id : null, traceId });
      }
      console.error('[client-crash]', text, context); // no DB — Railway logs still capture it
      return res.json({ ok: false, traceId });
    } catch (e) {
      console.error('[client-crash] store failed', e && e.message);
      return res.json({ ok: false });
    }
  });

  // ── Hand a bug to Claude Code (manual gate) ──
  // Fires a GitHub repository_dispatch → the claude-bugfix workflow attempts a fix and
  // opens a PR (never pushes to main, which auto-deploys). Needs GITHUB_REPO +
  // GITHUB_DISPATCH_TOKEN (PAT with repo/contents write) in the env; soft-off otherwise.
  const GH_REPO  = process.env.GITHUB_REPO || '';            // e.g. "schulmannn/pulse-analytics"
  const GH_TOKEN = process.env.GITHUB_DISPATCH_TOKEN || '';

  app.post('/api/bugs/:id/claude-fix', requireAuth, requireSuper, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    if (!GH_REPO || !GH_TOKEN) return res.status(503).json({ error: 'Не настроено: задай GITHUB_REPO и GITHUB_DISPATCH_TOKEN' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const bug = await db.getBug(id);
      if (!bug) return res.status(404).json({ error: 'баг не найден' });
      // Security (S1): the dispatched text/context drive a Claude agent with contents+PR write. Only
      // superuser-authored kinds may reach it — crash rows carry arbitrary user text (POST
      // /api/client-errors) and would be a prompt-injection channel into the CI agent.
      if (!canDispatchBugKind(bug.kind)) {
        return res.status(400).json({ error: 'Авто-фикс доступен только для баг/фича/правка — краши содержат непроверенный пользовательский текст и не передаются агенту' });
      }
      const r = await fetchWithTimeout(`https://api.github.com/repos/${GH_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GH_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'pulse-analytics-bugbot',
        },
        body: JSON.stringify({
          event_type: 'bug-fix-request',
          client_payload: {
            id: bug.id,
            // Defense-in-depth: neutralize prompt-escape scaffolding before it reaches the workflow
            // fence (the workflow wraps these in UNTRUSTED-BUG-REPORT markers + a guardrail preamble).
            text: sanitizeForPrompt(bug.text, 2000),
            severity: bug.severity,
            kind: bug.kind,
            context: sanitizeForPrompt(bug.context || '', 4000),
            attachments: bug.attachment_count || 0,
          },
        }),
      });
      if (r.status !== 204) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `GitHub dispatch failed (${r.status})`, detail: detail.slice(0, 300) });
      }
      await db.updateBug(id, 'in_progress').catch(() => {});   // reflect that Claude is on it
      res.json({ ok: true, status: 'in_progress' });
    } catch (e) { next(e); }
  });

  // ── Bug screenshots ──
  // SECURITY INVARIANT: ALLOWED_IMG must stay raster-only. NEVER add image/svg+xml
  // (or any scriptable type) — GET serves stored bytes with this mime, and SVG would
  // enable stored XSS despite nosniff.
  const ALLOWED_IMG = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const MAX_IMG_BYTES = 5 * 1024 * 1024;
  const MAX_ATTACH_PER_BUG = 5;

  // Verify the decoded bytes really are the claimed image type (magic bytes).
  function sniffImage(mime, buf) {
    if (buf.length < 12) return false;
    if (mime === 'image/png')  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    if (mime === 'image/jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (mime === 'image/gif')  return buf.slice(0, 4).toString('latin1') === 'GIF8';
    if (mime === 'image/webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
    return false;
  }

  // route-local parser (after requireAuth) so only this authed route accepts big bodies
  app.post('/api/bugs/:id/screenshot', requireAuth, requireSuper, express.json({ limit: '7mb' }), async (req, res, next) => {
    if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    let { data, mime } = req.body || {};
    if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'нет данных изображения' });
    const m = data.match(/^data:([^;,]+)[;,]/);          // data URL → trust its declared type (matches bytes)
    if (m) mime = m[1];
    data = data.replace(/^data:[^,]+,/, '');
    if (!mime) return res.status(400).json({ error: 'не удалось определить тип' });
    if (!ALLOWED_IMG.has(mime)) return res.status(415).json({ error: 'только изображения (png/jpeg/webp/gif)' });
    if (data.length > MAX_IMG_BYTES * 4 / 3 + 64) return res.status(413).json({ error: 'изображение больше 5 МБ' });
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'пустое или битое изображение' });
    if (buf.length > MAX_IMG_BYTES) return res.status(413).json({ error: 'изображение больше 5 МБ' });
    if (!sniffImage(mime, buf)) return res.status(415).json({ error: 'это не похоже на изображение' });
    try {
      if (!(await db.bugExists(id))) return res.status(404).json({ error: 'баг не найден' });
      const att = await db.addAttachmentIfRoom(id, mime, buf, MAX_ATTACH_PER_BUG);
      if (!att) return res.status(409).json({ error: `максимум ${MAX_ATTACH_PER_BUG} вложений на баг` });
      res.json(att);
    } catch (e) { next(e); }
  });

  // Served under auth (frontend fetches with the session token → blob URL).
  app.get('/api/bug-attachment/:id', requireAuth, requireSuper, async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).end();
    try {
      const a = await db.getAttachment(id);
      if (!a) return res.status(404).end();
      res.set('Content-Type', ALLOWED_IMG.has(a.mime) ? a.mime : 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', 'inline');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(a.data);
    } catch (e) { next(e); }
  });
}

module.exports = { registerBugsRoutes };
