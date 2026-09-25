'use strict';

const crypto = require('crypto');
const { parseStartPayload } = require('../lib/tgNotifyText');
const { hasWorkspaceRole } = require('../middleware/tenant');

/**
 * Уведомления об упоминаниях в личку Telegram — привязка бота и личная подписка.
 *
 *  - POST /api/tg-bot/webhook — единственный НЕавторизованный вход: Телеграм доставляет сюда
 *    /start <token> (deep-link привязка) и my_chat_member (бот заблокирован). Аутентификация —
 *    заголовок X-Telegram-Bot-Api-Secret-Token, сверяемый timing-safe с секретом, ДЕРИВИРОВАННЫМ
 *    из токена бота (lib/tgNotifyText.webhookSecretOf — отдельного env нет). Ответ Телеграму
 *    всегда 200, КРОМЕ временной недоступности БД (503 → Телеграм ретраит доставку update).
 *  - POST /api/tg/mention-notify/link — выдать deep-link t.me/<bot>?start=<token>. Токен уходит
 *    только клиенту; БД хранит sha256 (bearer-семантика, как email-токены). Лениво регистрирует
 *    вебхук (tgBot.ensureWebhook) — к моменту нажатия Start он гарантированно стоит.
 *  - GET/PUT /api/tg/mention-notify — статус и тумблер подписки на ВЫБРАННЫЙ канал. Подписка
 *    личная (uid+channel): достаточно ВИДЕТЬ канал (SQL-boundary channelAccessSql в репо) —
 *    поиск в джобе идёт через собственную managed-сессию подписчика и его же квоту searchPosts.
 *  - POST /api/tg/mention-notify/run — ручной прогон «Прислать сейчас»: owner/admin + durable
 *    кулдаун (см. ниже), потому что один вызов = один searchPosts из дневной квоты владельца
 *    сессии + до девяти сообщений ОБЩИМ ботом продукта.
 *  - DELETE /api/tg/mention-notify/binding — отвязать чат (подписки остаются и молчат до новой
 *    привязки).
 *
 * Токены/сессии/содержимое сообщений не логируются.
 */
function registerTgNotifyRoutes({
  app, requireAuth, resolveChannel, db, audit, log, tgBot, webhookSecret, newToken, sha256, appBase,
  runMentionNotifyTest,
}) {
  const DB_OFF = { error: 'База данных выключена — уведомления недоступны' };
  const BOT_OFF = { error: 'Бот уведомлений не настроен' };
  const LINK_TTL_MINUTES = 15;

  // Ручной прогон стоит дневной квоты searchPosts (~10/день) и шлёт карточки ОБЩИМ на весь продукт
  // ботом — тот же owner/admin-гейт, что у живого поиска в routes/mentions.js (там же и причина).
  const canEdit = (req) => hasWorkspaceRole(req.channel, req.user, 'admin');

  // Окно между ручными прогонами. Durable (строка jobs через runJobOnce), а не счётчик в памяти:
  // рестарт процесса и вторая реплика не обнуляют кулдаун. Ключ — календарное окно, как день-ключ
  // планового джоба (`${channel}:${uid}:${day}` в jobs/mentionNotifyJob): один прогон на окно, а
  // Retry-After честно называет остаток ЭТОГО окна.
  const RUN_COOLDOWN_MINUTES = 10;
  function runWindow(now = Date.now()) {
    const ms = RUN_COOLDOWN_MINUTES * 60 * 1000;
    const startedAt = Math.floor(now / ms) * ms;
    return { key: String(startedAt / ms), retryAfterSec: Math.max(1, Math.ceil((startedAt + ms - now) / 1000)) };
  }
  // Отказы ДО расхода квоты и отправки: окно за них не берём (иначе клик по кнопке с ненастроенной
  // подпиской «съедал» бы десять минут, ничего не защищая).
  const FREE_REFUSAL_REASONS = new Set(['not_configured', 'not_runnable']);

  const timingSafeEq = (a, b) => {
    const da = crypto.createHash('sha256').update(String(a)).digest();
    const dbuf = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(da, dbuf);
  };

  // ── Вебхук Телеграма (без requireAuth — гейт: derived secret token) ─────────────────────────────
  app.post('/api/tg-bot/webhook', async (req, res) => {
    const got = req.headers['x-telegram-bot-api-secret-token'] || '';
    if (!webhookSecret || !got || !timingSafeEq(got, webhookSecret)) {
      // Чужой/поддельный вызов: 403 без деталей. Телеграм с верным секретом сюда не попадает.
      return res.status(403).json({ ok: false });
    }
    if (!db.enabled) return res.json({ ok: true });   // БД выключена — молча подтверждаем

    const update = req.body || {};
    try {
      // Бот заблокирован/чат удалён → снести привязку, чтобы джоб не долбил 403.
      const member = update.my_chat_member;
      if (member && member.new_chat_member && member.chat &&
          ['kicked', 'left'].includes(member.new_chat_member.status)) {
        await db.unbindMentionNotifyChat(member.chat.id);
        return res.json({ ok: true });
      }

      const msg = update.message;
      const payload = msg && msg.chat && msg.chat.type === 'private'
        ? parseStartPayload(msg.text)
        : null;
      if (!payload) return res.json({ ok: true });    // не /start — просто подтверждаем update

      const from = msg.from || {};
      const uid = await db.bindMentionNotifyByToken(sha256(payload), {
        chat_id: msg.chat.id,
        tg_user_id: from.id,
        username: from.username,
      });
      // Ответ в чат — best-effort: сбой отправки не должен ронять подтверждение update.
      const reply = uid
        ? 'Готово! Уведомления об упоминаниях подключены. Управление — на странице «Упоминания» в Atlavue.'
        : 'Ссылка устарела или уже использована. Откройте Atlavue → «Упоминания» и привяжите бота заново.';
      tgBot.sendMessage(msg.chat.id, reply).catch(() => {});
      if (uid) log('info', 'tg_notify_bound', { uid });
      return res.json({ ok: true });
    } catch (e) {
      // Временная недоступность БД → 503: Телеграм повторит доставку update, привязка не потеряется.
      if (db.isDbUnavailable && db.isDbUnavailable(e)) return res.status(503).json({ ok: false });
      log('error', 'tg_notify_webhook_failed', { error: e.message });
      return res.json({ ok: true });                  // прочее — подтверждаем, чтобы не зациклить ретраи
    }
  });

  // ── Выдать deep-link для привязки ───────────────────────────────────────────────────────────────
  app.post('/api/tg/mention-notify/link', requireAuth, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(400).json(DB_OFF);
      if (!tgBot.configured()) return res.status(503).json(BOT_OFF);

      let username;
      try {
        username = await tgBot.getUsername();
        // Ленивая регистрация вебхука — идемпотентна; ошибка здесь = привязка не заработает,
        // поэтому честный 503, а не тихий проглот.
        await tgBot.ensureWebhook(`${appBase(req)}/api/tg-bot/webhook`, webhookSecret);
      } catch {
        return res.status(503).json(BOT_OFF);
      }

      const token = newToken();
      await db.issueMentionNotifyLink(req.user.uid, sha256(token), LINK_TTL_MINUTES);
      audit(req, 'tg.mention_notify.link_issued', {}).catch(() => {});
      res.json({ url: `https://t.me/${username}?start=${token}`, expires_in_minutes: LINK_TTL_MINUTES });
    } catch (e) { next(e); }
  });

  // ── Статус: привязка + подписка выбранного канала + чего не хватает ────────────────────────────
  app.get('/api/tg/mention-notify', requireAuth, resolveChannel, async (req, res, next) => {
    try {
      if (!db.enabled || !req.channel || req.channel.id == null) {
        return res.json({
          available: false, bot_configured: tgBot.configured(),
          binding: { bound: false }, subscription: { enabled: false },
          requirements: { rules_configured: false, session_state: 'missing' },
        });
      }
      const [binding, subscription, settings, sess] = await Promise.all([
        db.getMentionNotifyBinding(req.user.uid),
        db.getMentionNotifySubscription(req.channel.id, req.user.uid),
        db.getMentionSettingsForActor(req.channel.id, req.user),
        db.getTgSession(req.user.uid),
      ]);
      const sessionState = !sess || !sess.session_enc
        ? 'missing'
        : (sess.connection_state === 'reauth_required' ? 'reauth_required' : 'ok');
      res.json({
        available: true,
        bot_configured: tgBot.configured(),
        binding: {
          bound: !!(binding && binding.chat_id != null),
          username: (binding && binding.username) || null,
          bound_at: (binding && binding.bound_at) || null,
        },
        subscription: {
          enabled: !!(subscription && subscription.enabled),
          send_days: (subscription && Array.isArray(subscription.send_days))
            ? subscription.send_days.map(Number) : [],
          send_hour: subscription && Number.isInteger(Number(subscription.send_hour))
            ? Number(subscription.send_hour) : 10,
          last_run_at: (subscription && subscription.last_run_at) || null,
          last_notified_at: (subscription && subscription.last_notified_at) || null,
          last_error: (subscription && subscription.last_error) || null,
        },
        requirements: {
          rules_configured: !!(settings && settings.configured),
          session_state: sessionState,
        },
      });
    } catch (e) { next(e); }
  });

  // Валидация расписания из body: невалидный тип поля = 400 (а не тихое проглатывание),
  // отсутствие поля = «не менять» (repo COALESCE). Дни — ISO 1..7 без дублей; полный набор из
  // семи нормализуется в [] («каждый день» — каноническая форма, UI показывает все чипы).
  function parseSchedule(body) {
    const out = {};
    if (body && body.send_days !== undefined) {
      if (!Array.isArray(body.send_days)) throw badSchedule();
      const days = [...new Set(body.send_days.map(Number))];
      if (days.length > 7 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw badSchedule();
      if (days.length === 0) throw badSchedule();   // «ни одного дня» = бессмыслица, UI не даёт
      out.send_days = days.length === 7 ? [] : days.sort((a, b) => a - b);
    }
    if (body && body.send_hour !== undefined) {
      const hour = Number(body.send_hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw badSchedule();
      out.send_hour = hour;
    }
    return out;
  }
  function badSchedule() {
    const e = new Error('Некорректное расписание: дни — 1..7, час — 0..23');
    e.code = 'bad_schedule';
    return e;
  }

  // ── Тумблер подписки + расписание ───────────────────────────────────────────────────────────────
  app.put('/api/tg/mention-notify', requireAuth, resolveChannel, async (req, res, next) => {
    try {
      if (!db.enabled || !req.channel || req.channel.id == null) return res.status(400).json(DB_OFF);
      const enable = !!(req.body && req.body.enabled);
      let schedule;
      try {
        schedule = parseSchedule(req.body);
      } catch (e) {
        if (e && e.code === 'bad_schedule') return res.status(400).json({ error: e.message });
        throw e;
      }

      if (enable) {
        // Требования проверяются здесь (а не только в UI): включение без бота/привязки/правил/сессии
        // дало бы вечно-молчащую подписку. 409 + reason — фронт показывает, чего не хватает.
        if (!tgBot.configured()) return res.status(503).json(BOT_OFF);
        const [binding, settings, sess] = await Promise.all([
          db.getMentionNotifyBinding(req.user.uid),
          db.getMentionSettingsForActor(req.channel.id, req.user),
          db.getTgSession(req.user.uid),
        ]);
        if (!binding || binding.chat_id == null) {
          return res.status(409).json({ error: 'Сначала привяжите бота', reason: 'no_binding' });
        }
        if (!settings || !settings.configured) {
          return res.status(409).json({ error: 'Сначала настройте правила упоминаний', reason: 'no_rules' });
        }
        if (!sess || !sess.session_enc) {
          return res.status(409).json({ error: 'Подключите Telegram по QR — поиск идёт через вашу сессию', reason: 'no_session' });
        }
        if (sess.connection_state === 'reauth_required') {
          return res.status(409).json({ error: 'Сессия Telegram недействительна — переподключите аккаунт', reason: 'reauth_required' });
        }
      }

      const saved = await db.setMentionNotifySubscriptionForActor(req.channel.id, req.user, enable, schedule);
      if (!saved) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
      audit(req, enable ? 'tg.mention_notify.enabled' : 'tg.mention_notify.disabled', {
        channel_id: req.channel.id,
      }).catch(() => {});
      res.json({
        enabled: saved.enabled,
        send_days: Array.isArray(saved.send_days) ? saved.send_days.map(Number) : [],
        send_hour: Number(saved.send_hour),
        last_run_at: saved.last_run_at || null,
        last_notified_at: saved.last_notified_at || null,
        last_error: saved.last_error || null,
      });
    } catch (e) { next(e); }
  });

  // ── Ручной тест-прогон «Прислать сейчас» ────────────────────────────────────────────────────────
  // Явное действие пользователя: тратит ЕГО квоту searchPosts вне планового дня-ключа и шлёт до
  // девяти сообщений общим ботом. Поэтому два гейта поверх requireAuth/resolveChannel: роль
  // owner/admin (viewer не должен жечь чужую квоту и писать в общий архив канала) и durable
  // кулдаун. Джоб сам проверяет полную выполнимость (binding+rules+сессия+enabled) — здесь только
  // гейты и маппинг ответа.
  app.post('/api/tg/mention-notify/run', requireAuth, resolveChannel, async (req, res, next) => {
    try {
      if (!db.enabled || !req.channel || req.channel.id == null) return res.status(400).json(DB_OFF);
      if (!canEdit(req)) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      if (!runMentionNotifyTest) return res.status(503).json(BOT_OFF);

      const cooldown = runWindow();
      let outcome;
      try {
        outcome = await db.runJobOnce(
          'mention_notify_manual',
          `${req.channel.id}:${req.user.uid}:${cooldown.key}`,
          async () => {
            const result = await runMentionNotifyTest(req.channel.id, req.user.uid);
            // Отказ до расхода квоты — не «прогон»: бросаем, чтобы runJobOnce записал строку failed,
            // и следующий claim того же окна переклеймил её (claimJob переклеймливает failed).
            if (!result.ok && FREE_REFUSAL_REASONS.has(result.reason)) {
              const free = new Error(`manual run refused: ${result.reason}`);
              free.code = 'manual_run_free_refusal';
              free.result = result;
              throw free;
            }
            return result;
          },
        );
      } catch (e) {
        if (!e || e.code !== 'manual_run_free_refusal') throw e;
        outcome = { skipped: false, result: e.result };
      }
      // Окно уже занято своим же прошлым прогоном (или параллельным кликом) — честный 429 с
      // остатком окна, а не тихий второй расход квоты.
      if (outcome.skipped) {
        res.set('Retry-After', String(cooldown.retryAfterSec));
        return res.status(429).json({
          ok: false,
          reason: 'cooldown',
          error: `Слишком часто: ручной прогон доступен раз в ${RUN_COOLDOWN_MINUTES} минут — попробуйте позже`,
          retry_after_sec: cooldown.retryAfterSec,
        });
      }

      const out = outcome.result;
      audit(req, 'tg.mention_notify.test_run', { channel_id: req.channel.id, ok: out.ok }).catch(() => {});
      if (!out.ok) {
        const status = out.reason === 'not_runnable' ? 409 : 503;
        const RU = {
          not_configured: 'Бот уведомлений не настроен',
          not_runnable: 'Подписка не готова: включите её и закройте требования из чек-листа',
          reauth_required: 'Сессия Telegram недействительна — переподключите аккаунт',
          bot_blocked: 'Бот заблокирован в Telegram — привяжите чат заново',
          send_failed: 'Не удалось отправить сообщение, попробуйте позже',
          send_throttled: 'Telegram просит подождать — остальные карточки придут следующим прогоном',
          search_failed: 'Поиск не удался (квота или сбой Telegram), попробуйте позже',
          session_decrypt_failed: 'Сессия Telegram недоступна — переподключите аккаунт',
        };
        // Троттлинг Телеграма знает СВОЙ срок ожидания — отдаём его клиенту, а не общий кулдаун.
        if (out.retry_after_sec) res.set('Retry-After', String(out.retry_after_sec));
        return res.status(status).json({ ok: false, reason: out.reason, error: RU[out.reason] || RU.search_failed });
      }
      res.json(out);
    } catch (e) { next(e); }
  });

  // ── Отвязать чат ────────────────────────────────────────────────────────────────────────────────
  app.delete('/api/tg/mention-notify/binding', requireAuth, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(400).json(DB_OFF);
      await db.deleteMentionNotifyBinding(req.user.uid);
      audit(req, 'tg.mention_notify.unbound', {}).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

module.exports = { registerTgNotifyRoutes };
