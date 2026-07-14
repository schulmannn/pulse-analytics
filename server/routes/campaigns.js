'use strict';

/**
 * Campaigns routes («Кампании и группы контента») — /api/campaigns.
 *
 * CRUD кампаний + batch-membership публикаций + обогащённый список постов + сводка.
 * Скоуп — workspace (репо вшивает access-предикаты); роут различает:
 *   401 — requireAuth; 404 — кампания вне доступа/не существует (репо вернул null,
 *   без утечки существования); 403 — роль viewer на write-операции ИЛИ попытка добавить
 *   пост из недоступного пользователю канала; 409 — дубль имени в воркспейсе /
 *   лимит публикаций; 400 — валидация. Фильтрация контента по campaign_id живёт здесь же:
 *   GET /api/campaigns/:id/posts — единственный источник membership для фронтового
 *   фильтра «Контента» (в /api/tg/full и /api/ig/posts кампании не подмешиваются).
 *
 * Метрики платформ намеренно раздельные (tg.views ≠ ig.reach/views по методологии);
 * сводка отдаёт их отдельными блоками — см. campaignsRepo.getCampaignSummary.
 */

const CAMPAIGNS_DB_OFF = { error: 'БД не подключена — кампании недоступны' };
const ID_RE = /^\d{1,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TG_REF_RE = /^\d{1,19}$/;
const IG_REF_RE = /^[\w.-]{1,80}$/;
const WRITE_ROLES = ['member', 'admin', 'owner'];
const PG_BIGINT_MAX = 9223372036854775807n;

function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isValidTgRef(value) {
  if (!TG_REF_RE.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= PG_BIGINT_MAX;
  }
  catch { return false; }
}

const isValidId = (value) => ID_RE.test(String(value)) && Number(value) > 0;

function registerCampaignsRoutes({ app, db, requireAuth, audit }) {
  const STATUSES = db.CAMPAIGN_STATUSES || ['active', 'completed', 'archived'];
  const BATCH_LIMIT = db.CAMPAIGN_BATCH_LIMIT || 100;

  // ── валидация полей кампании (create/patch); возвращает {error} | {value} ──
  function campaignFieldsError(body, { partial } = {}) {
    const out = {};
    if (!partial || body.name !== undefined) {
      if (typeof body.name !== 'string') return { error: 'name: строка от 1 до 120 символов' };
      const name = String((body && body.name) || '').trim();
      if (!name || name.length > 120) return { error: 'name: от 1 до 120 символов' };
      out.name = name;
    }
    if (body.description !== undefined) {
      if (body.description != null && typeof body.description !== 'string') return { error: 'description: строка' };
      const d = String(body.description || '');
      if (d.length > 2000) return { error: 'description: до 2000 символов' };
      out.description = d;
    }
    if (body.color !== undefined) {
      if (body.color != null && (typeof body.color !== 'string' || !COLOR_RE.test(body.color))) {
        return { error: 'color: ожидается #RRGGBB' };
      }
      out.color = body.color ? body.color.toLowerCase() : null;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return { error: `status: ${STATUSES.join('|')}` };
      out.status = body.status;
    }
    for (const key of ['start_date', 'end_date']) {
      if (body[key] === undefined) continue;
      if (body[key] != null) {
        if (!isValidCalendarDate(body[key])) {
          return { error: `${key}: ожидается YYYY-MM-DD` };
        }
      }
      out[key] = body[key] || null;
    }
    if (out.start_date && out.end_date && out.end_date < out.start_date) {
      return { error: 'end_date раньше start_date' };
    }
    return { value: out };
  }

  // Один пункт batch-запроса membership. withMeta=true (add) разрешает ig-метаданные.
  function itemError(raw, { withMeta } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'items[]: ожидается объект' };
    const network = raw.network;
    if (network !== 'tg' && network !== 'ig') return { error: 'items[].network: tg|ig' };
    const channelId = Number(raw.channel_id);
    if (!Number.isInteger(channelId) || channelId <= 0 || channelId > 1e9) return { error: 'items[].channel_id: bad id' };
    const ref = String(raw.post_ref == null ? '' : raw.post_ref);
    if (network === 'tg' ? !isValidTgRef(ref) : !IG_REF_RE.test(ref)) return { error: 'items[].post_ref: bad id' };
    const item = { network, channel_id: channelId, post_ref: ref };
    if (withMeta && network === 'ig') {
      if (raw.published_at != null) {
        if (typeof raw.published_at !== 'string' || Number.isNaN(Date.parse(raw.published_at))) {
          return { error: 'items[].published_at: ожидается ISO-дата' };
        }
        item.published_at = new Date(raw.published_at).toISOString();
      }
      if (raw.media_type != null) {
        if (typeof raw.media_type !== 'string') return { error: 'items[].media_type: строка' };
        item.media_type = raw.media_type.slice(0, 40);
      }
      if (raw.caption != null) {
        if (typeof raw.caption !== 'string') return { error: 'items[].caption: строка' };
        item.caption = raw.caption.slice(0, 300);
      }
    }
    return { item };
  }

  function parseItems(body, opts) {
    const raw = body && body.items;
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'items: непустой массив' };
    if (raw.length > BATCH_LIMIT) return { error: `items: не больше ${BATCH_LIMIT} за запрос` };
    const items = [];
    const seen = new Set();
    for (const r of raw) {
      const parsed = itemError(r, opts);
      if (parsed.error) return { error: parsed.error };
      const key = `${parsed.item.network}:${parsed.item.channel_id}:${parsed.item.post_ref}`;
      if (seen.has(key)) continue; // дубль внутри запроса — схлопываем, лимиты считаем честно
      seen.add(key);
      items.push(parsed.item);
    }
    return { items };
  }

  // 404 до 403: несуществующая/чужая кампания не раскрывается; 403 — только про роль.
  async function loadWritable(req, res) {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'bad id' });
      return null;
    }
    const campaign = await db.getCampaign(req.user.uid, Number(req.params.id));
    if (!campaign) {
      res.status(404).json({ error: 'Кампания не найдена' });
      return null;
    }
    if (!WRITE_ROLES.includes(campaign.my_role)) {
      res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      return null;
    }
    return campaign;
  }

  const conflict = (res, e) => {
    if (e && e.code === 'campaign_name_conflict') {
      res.status(409).json({ error: 'Кампания с таким названием уже есть' });
      return true;
    }
    if (e && e.code === 'campaign_limit') {
      res.status(409).json({ error: e.message });
      return true;
    }
    if (e && e.code === 'campaign_channel_forbidden') {
      res.status(403).json({ error: 'Нет доступа к источнику' });
      return true;
    }
    if (e && e.code === 'campaign_role_forbidden') {
      res.status(403).json({ error: 'Недостаточно прав в рабочем пространстве' });
      return true;
    }
    if (e && e.code === 'campaign_workspace_mismatch') {
      res.status(409).json({ error: 'Источник относится к другому рабочему пространству' });
      return true;
    }
    if (e && e.code === 'campaign_network_mismatch') {
      res.status(400).json({ error: 'Платформа публикации не совпадает с источником' });
      return true;
    }
    if (e && e.code === '23514') { // CHECK (end_date >= start_date) — частичный PATCH одной даты
      res.status(400).json({ error: 'end_date раньше start_date' });
      return true;
    }
    return false;
  };

  app.get('/api/campaigns', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    const status = req.query.status;
    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: `status: ${STATUSES.join('|')}` });
    }
    const channelId = req.query.channel_id;
    if (channelId !== undefined && !isValidId(channelId)) {
      return res.status(400).json({ error: 'channel_id: bad id' });
    }
    try {
      const campaigns = await db.listCampaigns(req.user.uid, {
        status,
        channelId: channelId === undefined ? undefined : Number(channelId),
      });
      res.json({ campaigns });
    } catch (e) { next(e); }
  });

  app.post('/api/campaigns', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    const parsed = campaignFieldsError(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const channelId = req.body && req.body.channel_id;
    if (!isValidId(channelId)) return res.status(400).json({ error: 'channel_id: bad id' });
    parsed.value.channel_id = Number(channelId);
    try {
      const campaign = await db.createCampaign(req.user.uid, parsed.value);
      if (!campaign) return res.status(503).json(CAMPAIGNS_DB_OFF);
      audit(req, 'campaign.created', { campaign_id: campaign.id }).catch(() => {});
      res.json({ campaign });
    } catch (e) {
      if (conflict(res, e)) return;
      next(e);
    }
  });

  app.get('/api/campaigns/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    try {
      const campaign = await db.getCampaign(req.user.uid, Number(req.params.id));
      if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
      res.json({ campaign });
    } catch (e) { next(e); }
  });

  app.patch('/api/campaigns/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    try {
      const current = await loadWritable(req, res);
      if (!current) return;
      const parsed = campaignFieldsError(req.body || {}, { partial: true });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      // Кросс-проверка дат с учётом уже сохранённых значений (одиночный PATCH одной даты).
      const start = parsed.value.start_date !== undefined ? parsed.value.start_date : current.start_date;
      const end = parsed.value.end_date !== undefined ? parsed.value.end_date : current.end_date;
      if (start && end && end < start) return res.status(400).json({ error: 'end_date раньше start_date' });
      const campaign = await db.updateCampaign(req.user.uid, current.id, parsed.value);
      if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
      audit(req, 'campaign.updated', { campaign_id: campaign.id }).catch(() => {});
      res.json({ campaign });
    } catch (e) {
      if (conflict(res, e)) return;
      next(e);
    }
  });

  app.delete('/api/campaigns/:id', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    try {
      const current = await loadWritable(req, res);
      if (!current) return;
      const ok = await db.deleteCampaign(req.user.uid, current.id);
      if (!ok) return res.status(404).json({ error: 'Кампания не найдена' });
      audit(req, 'campaign.deleted', { campaign_id: current.id }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/campaigns/:id/posts', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    try {
      const current = await loadWritable(req, res);
      if (!current) return;
      const parsed = parseItems(req.body, { withMeta: true });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const result = await db.addCampaignPosts(req.user.uid, current.id, parsed.items);
      if (!result) return res.status(404).json({ error: 'Кампания не найдена' });
      audit(req, 'campaign.posts_added', { campaign_id: current.id, added: result.added }).catch(() => {});
      res.json(result);
    } catch (e) {
      if (conflict(res, e)) return;
      next(e);
    }
  });

  app.delete('/api/campaigns/:id/posts', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    try {
      const current = await loadWritable(req, res);
      if (!current) return;
      const parsed = parseItems(req.body, { withMeta: false });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const result = await db.removeCampaignPosts(req.user.uid, current.id, parsed.items);
      if (!result) return res.status(404).json({ error: 'Кампания не найдена' });
      audit(req, 'campaign.posts_removed', { campaign_id: current.id, removed: result.removed }).catch(() => {});
      res.json(result);
    } catch (e) { next(e); }
  });

  // Публикации кампании (обогащённые метриками на лету) — это и есть серверная
  // фильтрация контента по campaign_id; фронтовый фильтр «Контента» читает отсюда.
  app.get('/api/campaigns/:id/posts', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    try {
      const rows = await db.listCampaignPosts(req.user.uid, Number(req.params.id));
      if (rows == null) return res.status(404).json({ error: 'Кампания не найдена' });
      // Do not expose channel ids or post refs for sources the current actor cannot read. The
      // summary reports the count separately, which is enough for an honest unavailable state.
      const posts = rows.filter((r) => r.accessible);
      res.json({ posts, inaccessible_count: rows.length - posts.length });
    } catch (e) { next(e); }
  });

  app.get('/api/campaigns/:id/summary', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(503).json(CAMPAIGNS_DB_OFF);
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    try {
      const summary = await db.getCampaignSummary(req.user.uid, Number(req.params.id));
      if (!summary) return res.status(404).json({ error: 'Кампания не найдена' });
      res.json({ summary });
    } catch (e) { next(e); }
  });
}

module.exports = { registerCampaignsRoutes };
