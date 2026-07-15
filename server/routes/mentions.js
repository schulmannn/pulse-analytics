'use strict';

const { hasWorkspaceRole } = require('../middleware/tenant');
const { validateRules } = require('../lib/mentionRules');

/**
 * Telegram mention rules + live brand-search — `/api/tg/mention-settings` (GET/PUT) and the moved
 * `/api/tg/mtproto/mentions` (GET). Extracted out of routes/tg.js because it needs a distinct shape:
 * rules stored PER selected channel (channel_mention_settings, миграция 018), and a live search that
 * spends the ~10/day searchPosts quota through the CALLING USER's own encrypted managed QR-session —
 * not one global legacy session, and not central-only.
 *
 * Security invariants:
 *  - GET settings: любой, кто ВИДИТ канал (viewer+), читает; can_edit отражает owner/admin.
 *  - PUT settings: только owner/admin (проверка роли + SQL-boundary в репо), тело валидируется чистым
 *    lib/mentionRules (400), запись actor-gated (403 при недостатке прав), пишем аудит.
 *  - GET mentions: owner/admin ТОЛЬКО (тратит квоту). Настройки берём для выбранного канала; если не
 *    настроено — 409. Сессию грузим для req.user.uid; нет/reauth_required — 409. Расшифровка ТОЛЬКО
 *    на сервере (tgCrypto), plaintext уходит исключительно в тело приватного /mentions/search.
 *  - Никогда не логируем сессию и содержимое правил.
 */
function registerMentionsRoutes({
  app, requireAuth, resolveChannel, db, audit, log,
  cacheGet, cacheSet, tgCrypto, mtprotoClient,
}) {
  const { mtprotoPost, sendMtprotoError, MTPROTO_TOKEN, MTPROTO_TIMEOUT_HEAVY_MS } = mtprotoClient;

  const DB_OFF = { error: 'База данных выключена — упоминания недоступны' };

  function canEdit(req) {
    return hasWorkspaceRole(req.channel, req.user, 'admin');
  }

  // Own-source: имя/tg-id выбранного канала — всегда авто-исключение (свой бренд не «упоминание»).
  function ownSource(req) {
    const ch = req.channel || {};
    return {
      username: ch.username ? String(ch.username).replace(/^@/, '') || null : null,
      tg_channel_id: ch.tg_channel_id == null ? null : String(ch.tg_channel_id),
    };
  }

  // ── GET /api/tg/mention-settings — читает viewer+; can_edit=owner/admin ──────────────────────────
  app.get('/api/tg/mention-settings', requireAuth, resolveChannel, async (req, res, next) => {
    try {
      if (!db.enabled || !req.channel || req.channel.id == null) {
        return res.json({
          configured: false,
          rules: { include_terms: [], exclude_terms: [], exclude_sources: [], match_mode: 'contains' },
          revision: 0, updated_at: null, can_edit: false, own_source: ownSource(req),
        });
      }
      const settings = await db.getMentionSettingsForActor(req.channel.id, req.user);
      if (!settings) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
      res.json({
        configured: settings.configured,
        rules: {
          include_terms: settings.include_terms,
          exclude_terms: settings.exclude_terms,
          exclude_sources: settings.exclude_sources,
          match_mode: settings.match_mode,
        },
        revision: settings.revision,
        updated_at: settings.updated_at,
        can_edit: canEdit(req),
        own_source: ownSource(req),
      });
    } catch (e) { next(e); }
  });

  // ── PUT /api/tg/mention-settings — owner/admin only ─────────────────────────────────────────────
  app.put('/api/tg/mention-settings', requireAuth, resolveChannel, async (req, res, next) => {
    try {
      if (!db.enabled || !req.channel || req.channel.id == null) return res.status(400).json(DB_OFF);
      // Роль-гейт до валидации: viewer не должен даже узнавать детали валидации.
      if (!canEdit(req)) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });

      let rules;
      try {
        rules = validateRules(req.body);
      } catch (e) {
        if (e && e.code === 'mention_rules_invalid') return res.status(400).json({ error: e.message });
        throw e;
      }

      const saved = await db.upsertMentionSettingsForActor(req.channel.id, req.user, rules);
      // null = SQL-boundary отверг (гонка/забытый гейт) → честный 403, а не тихий успех.
      if (!saved) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });

      // Аудит без содержимого правил: только размеры/режим (не тащим бренд-термины в журнал).
      audit(req, 'tg.mention_settings.updated', {
        channel_id: req.channel.id,
        include: saved.include_terms.length,
        exclude: saved.exclude_terms.length,
        sources: saved.exclude_sources.length,
        match_mode: saved.match_mode,
      }).catch(() => {});

      res.json({
        configured: saved.configured,
        rules: {
          include_terms: saved.include_terms,
          exclude_terms: saved.exclude_terms,
          exclude_sources: saved.exclude_sources,
          match_mode: saved.match_mode,
        },
        revision: saved.revision,
        updated_at: saved.updated_at,
        can_edit: true,
        own_source: ownSource(req),
      });
    } catch (e) { next(e); }
  });

  // ── GET /api/tg/mtproto/mentions — живой поиск (owner/admin; тратит квоту) ───────────────────────
  // Публичный браузерный контракт (форма ответа как раньше, без `all`), но теперь: per-channel
  // правила + сессия ВЫЗЫВАЮЩЕГО пользователя. Только ручной вызов (по кнопке) — квота ~10/день.
  app.get('/api/tg/mtproto/mentions', requireAuth, resolveChannel, async (req, res, next) => {
    try {
      if (!db.enabled || !req.channel || req.channel.id == null) return res.status(400).json(DB_OFF);
      // Owner/admin only — поиск расходует ограниченную дневную квоту searchPosts.
      if (!canEdit(req)) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      if (!MTPROTO_TOKEN || !tgCrypto.configured()) {
        return res.status(503).json({ available: false, error: 'Сервис Telegram не настроен' });
      }

      const settings = await db.getMentionSettingsForActor(req.channel.id, req.user);
      if (!settings) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
      if (!settings.configured) {
        return res.status(409).json({ available: false, error: 'Правила упоминаний не настроены для этого канала' });
      }

      const sess = await db.getTgSession(req.user.uid);
      if (!sess || !sess.session_enc) {
        return res.status(409).json({ available: false, error: 'Подключите Telegram по QR, чтобы искать упоминания', reason: 'no_session' });
      }
      if (sess.connection_state === 'reauth_required') {
        return res.status(409).json({ available: false, error: 'Сессия Telegram недействительна — переподключите аккаунт', reason: 'reauth_required' });
      }

      // Кэш общий для канала и revision, но только пользователь с собственной действующей
      // managed-сессией может его запросить. Иначе кэш маскировал бы no_session/reauth_required.
      const cacheKey = `mtproto:mentions:${req.channel.id}:r${settings.revision}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      let sessionStr;
      try {
        sessionStr = tgCrypto.decrypt(sess.session_enc);
      } catch {
        // Битый блоб/ротация ключа — безопасно, без утечки: генерация-гардом помечаем reauth.
        recordReauth(req.user.uid, sess.session_version, 'session_decrypt_failed');
        return res.status(409).json({ available: false, error: 'Сессия Telegram недоступна — переподключите аккаунт', reason: 'reauth_required' });
      }

      const own = ownSource(req);
      // Авто-исключение своего канала: username → exclude_sources, tg-id → exclude_channel_ids.
      const excludeSources = own.username
        ? [...settings.exclude_sources, own.username]
        : settings.exclude_sources.slice();
      const excludeChannelIds = own.tg_channel_id ? [own.tg_channel_id] : [];

      let data;
      try {
        data = await mtprotoPost('/mentions/search', {
          body: {
            session: sessionStr,
            include_terms: settings.include_terms,
            exclude_terms: settings.exclude_terms,
            exclude_sources: excludeSources,
            exclude_channel_ids: excludeChannelIds,
            match_mode: settings.match_mode,
          },
          timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
        });
      } catch (e) {
        // Управляемая сессия невалидна (Telethon UnauthorizedError → Python 401 session_unauthorized):
        // генерация-гардом фиксируем reauth_required. НЕ логируем сессию/правила.
        if (e && (e.status === 401 || e.code === 'session_unauthorized')) {
          recordReauth(req.user.uid, sess.session_version, 'session_unauthorized');
          return res.status(409).json({ available: false, error: 'Сессия Telegram недействительна — переподключите аккаунт', reason: 'reauth_required' });
        }
        return sendMtprotoError(res, e);
      }

      if (data && data.available) {
        // Успешный реальный поиск — сессия жива: штампуем success (best-effort, не роняет ответ).
        if (sess.session_version) {
          db.recordTgSessionSuccess(req.user.uid, sess.session_version).catch((err) =>
            log('warn', 'mentions_session_success_write_failed', { error: err.message }));
        }
        // Персистим полный дедуп-список в архив ДО ответа (контракт «Обновить»: клиент перечитывает
        // архив). Ошибка записи — явный 5xx, а не тихий лог, иначе фронт подтвердит «обновлено».
        if (Array.isArray(data.all)) {
          try {
            await db.upsertMentions(req.channel.id, data.all);
          } catch (err) {
            log('error', 'mentions_archive_write_failed', {
              channel_id: req.channel.id,
              error: err instanceof Error ? err.message : String(err),
            });
            return res.status(503).json({ available: false, error: 'Не удалось обновить архив упоминаний. Повторите позже.' });
          }
        }
        delete data.all;          // не отдаём полный список клиенту
        cacheSet(cacheKey, data);  // кэшируем только успех
      }
      res.json(data);
    } catch (e) { next(e); }
  });

  // Генерация-гардом (session_version) фиксируем reauth_required; поздний результат прежней сессии
  // не перезапишет health свежеподключённой. Best-effort — health-запись никогда не роняет ответ.
  function recordReauth(uid, sessionVersion, errorCode) {
    if (!uid || !sessionVersion) return;
    db.recordTgSessionFailure(uid, sessionVersion, { state: 'reauth_required', errorCode })
      .catch((err) => log('warn', 'mentions_session_reauth_write_failed', { error: err.message }));
  }
}

module.exports = { registerMentionsRoutes };
