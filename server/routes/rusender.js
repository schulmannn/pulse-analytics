'use strict';

const { hasWorkspaceRole, tenantChannelId } = require('../middleware/tenant');

/**
 * Роуты Rusender (/api/rusender/{connect,status,account}) — серверная половина источника
 * email-рассылок, зеркально вертикали Яндекс.Метрики.
 *
 * ЭТОТ ФАЙЛ — СЛОЙ ПОДКЛЮЧЕНИЯ. Витринные data-роуты (обзор, лента рассылок, разрезы) приезжают
 * следующим шагом: сначала владелец заводит ключ, и мы смотрим на РЕАЛЬНЫЕ ответы Rusender,
 * а не на одну лишь OpenAPI-спеку. Спека уже показала минимум два места, где ей нельзя верить
 * на слово (имена параметров пагинации не документированы вовсе; статистика A/B-рассылки в
 * списке — агрегат по семье, а в get-by-id — своя), поэтому форма витрин фиксируется по живым
 * данным.
 *
 * connect валидирует ключ живым identity-вызовом (GET /v1/public/me) и сохраняет его ТОЛЬКО
 * шифрованным (lib/rusender_crypto). Ключ нигде не логируется и не попадает в ответы/сообщения
 * ошибок (rusenderClient держит его только в заголовке запроса).
 * connect/disconnect пишут audit-события rusender_connect/rusender_disconnect (зеркало
 * ym_connect) — только identity-поля аккаунта, ключей в metadata нет.
 */

// Разрешения ключа, без которых источник бесполезен. Rusender выдаёт ключи с произвольным
// набором scope'ов, и «ключ верный, но читать им нечего» — самая частая реальная осечка
// подключения. Поэтому проверяем ЯВНО и говорим, чего именно не хватает, а не отдаём молча
// подключённый источник, который завтра соберёт пустоту.
const REQUIRED_SCOPES = Object.freeze([
  { scope: 'campaigns.read', why: 'рассылки и их статистика' },
  { scope: 'contacts.read', why: 'размер базы контактов' },
]);

function registerRusenderRoutes({ app, requireAuth, db, audit, rusenderCrypto, rusenderFetch, log }) {
  /**
   * Канал + учётка Rusender для запроса. Порядок проверок — канон resolveYm/resolveMs:
   * БД → ключ шифрования → канал/учётка. `optional` — для status/disconnect, которым 404
   * на отсутствующей учётке не нужен.
   */
  async function resolveRusenderChannel(req, res, { optional = false } = {}) {
    const wanted = tenantChannelId(req);
    const channel = await db.getChannelOrDefault(wanted, req.user).catch(() => null);
    if (!channel) {
      // Явно запрошенный чужой канал — 403; отсутствие подключения вообще — 404.
      if (wanted) {
        res.status(403).json({ error: 'Нет доступа к этому каналу' });
        return null;
      }
      if (optional) return { channel: null, acc: null };
      res.status(404).json({ error: 'Rusender не подключён к этому каналу' });
      return null;
    }
    const acc = await db.getRusenderAccount(channel.id).catch(() => null);
    if (!acc || !acc.api_key_enc) {
      if (optional) return { channel, acc: null };
      res.status(404).json({ error: 'Rusender не подключён к этому каналу' });
      return null;
    }
    return { channel, acc };
  }

  /** Каких обязательных разрешений не хватает ключу. Пустой массив = всё на месте. */
  function missingScopes(scopes) {
    const have = new Set((Array.isArray(scopes) ? scopes : []).map((s) => String(s)));
    return REQUIRED_SCOPES.filter((r) => !have.has(r.scope));
  }

  /**
   * POST /api/rusender/connect — подключить аккаунт Rusender по API-ключу.
   *
   * Валидация — живым identity-вызовом GET /v1/public/me: он не требует ни одного scope, поэтому
   * отличает «ключ не тот» (401) от «ключу не выдали разрешений» (ключ верный, scopes пустые).
   * Смешивать эти две осечки в одно «неверный ключ» — значит отправить человека перевыпускать
   * рабочий ключ вместо того, чтобы дать ему галочки в кабинете Rusender.
   *
   * Дедуп по accountId: повторный connect того же аккаунта обновляет ключ существующего канала,
   * а не заводит второй источник с тем же содержимым.
   */
  app.post('/api/rusender/connect', requireAuth, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(503).json({ error: 'База данных недоступна' });
      if (!rusenderCrypto.configured()) return res.status(503).json({ error: 'RUSENDER_KEY не задан' });
      const apiKey = req.body && typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
      if (!apiKey) return res.status(400).json({ error: 'Укажи API-ключ Rusender' });

      let me;
      try {
        const resp = await rusenderFetch(apiKey, '/v1/public/me');
        me = (resp && resp.data) || null;
      } catch (e) {
        const status = Number(e && e.status) || 0;
        // Ключа в e.message нет по построению rusenderClient — логируем сообщение спокойно.
        log('warn', 'rusender_connect_failed', { status, error: e && e.message });
        // 401/403 здесь = ПРИСЛАННЫЙ ключ не подошёл (ошибка ввода), а не отзыв сохранённого.
        if (status === 401 || status === 403) {
          return res.status(400).json({ error: 'Ключ отклонён Rusender' });
        }
        if (status === 429) {
          const retryAfter = Math.ceil((Number(e.retryAfterMs) || 60000) / 1000);
          res.set('Retry-After', String(retryAfter));
          return res.status(503).json({ error: 'Rusender ограничил частоту запросов, попробуй позже' });
        }
        return res.status(502).json({ error: 'Rusender недоступен' });
      }

      const accountId = me && me.accountId != null ? String(me.accountId) : '';
      if (!accountId) {
        // Ключ принят, но identity не пришла — источник без идентичности завести нельзя
        // (дедуп повторного connect держится именно на accountId).
        log('warn', 'rusender_connect_no_identity', {});
        return res.status(502).json({ error: 'Rusender не вернул идентификатор аккаунта' });
      }
      const accountEmail = me && typeof me.accountEmail === 'string' && me.accountEmail.trim()
        ? me.accountEmail.trim()
        : null;
      const scopes = Array.isArray(me.scopes) ? me.scopes.map((s) => String(s)) : [];

      // Ключ без нужных разрешений НЕ сохраняем: подключённый источник, который не может ничего
      // прочитать, — это тихая поломка, которая всплывёт через сутки пустым обзором.
      const missing = missingScopes(scopes);
      if (missing.length) {
        return res.status(400).json({
          error: `Ключу не хватает разрешений: ${missing.map((m) => m.scope).join(', ')}. `
            + 'Выдай их ключу в кабинете Rusender и подключи снова.',
          missing_scopes: missing.map((m) => m.scope),
        });
      }

      let channelId = await db.findRusenderChannelByAccount(req.user.uid, accountId);
      if (!channelId) {
        // ПОДКЛЮЧИТЬ В УКАЗАННЫЙ КАНАЛ, если запрос пришёл с его id, это rusender-канал этого
        // воркспейса и учётки на нём сейчас нет. Такой канал остаётся после «Отключить» (учётку
        // удаляем, архив НЕТ) — без этой ветки повторное подключение того же аккаунта заводило бы
        // НОВЫЙ канал, а старый навсегда висел бы в переключателе пустым источником (урок #539).
        const wanted = tenantChannelId(req);
        if (wanted) {
          const channel = await db.getChannelOrDefault(wanted, req.user).catch(() => null);
          if (
            channel
            && channel.id === wanted
            && channel.source === 'rusender'
            && hasWorkspaceRole(channel, req.user, 'admin')
          ) {
            const existing = await db.getRusenderAccount(channel.id).catch(() => null);
            if (!existing || !existing.api_key_enc) channelId = channel.id;
          }
        }
      }
      if (!channelId) {
        const created = await db.createRusenderChannel({ owner_uid: req.user.uid, name: accountEmail || 'Rusender' });
        if (!created) return res.status(503).json({ error: 'Не удалось создать канал' });
        channelId = created.id;
      }

      await db.saveRusenderAccount(channelId, {
        account_id: accountId,
        account_email: accountEmail,
        scopes,
        api_key_enc: rusenderCrypto.encrypt(apiKey),
      });
      // Аудит подключения (зеркало ym_connect): только identity-поля аккаунта. Ключа в metadata
      // нет и быть не может: audit-строки живут год.
      await audit(req, 'rusender_connect', { channelId, accountId, accountEmail });
      res.json({ ok: true, channel_id: channelId, account_email: accountEmail, scopes });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/rusender/status — состояние подключения для Settings/connect-CTA. Без 404 при
   * отсутствии учётки и без расшифровки ключа: connected — это «строка rusender_accounts
   * существует», ничего секретного наружу.
   */
  app.get('/api/rusender/status', requireAuth, async (req, res, next) => {
    try {
      const resolved = await resolveRusenderChannel(req, res, { optional: true });
      if (!resolved) return;
      const acc = resolved.acc;
      res.json({
        connected: !!acc,
        channel_id: resolved.channel ? resolved.channel.id : null,
        account_email: acc ? acc.account_email || null : null,
        account_id: acc ? acc.account_id || null : null,
        scopes: acc && Array.isArray(acc.scopes) ? acc.scopes : [],
        // Разрешения могли отозвать уже ПОСЛЕ подключения — показываем это на экране источника,
        // а не оставляем пользователя гадать, почему обзор перестал наполняться.
        missing_scopes: acc ? missingScopes(acc.scopes).map((m) => m.scope) : [],
        connected_at: acc ? acc.connected_at || null : null,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * DELETE /api/rusender/account — отключить Rusender от канала. Сносится ТОЛЬКО учётка (ключ);
   * канал и архив (rusender_daily/campaigns/activity) живут дальше — история остаётся, повторный
   * connect её продолжит. Идемпотентно: повторный DELETE без учётки — тот же { ok:true }.
   * Отключение — admin-действие воркспейса (зеркало DELETE /api/ym/account).
   */
  app.delete('/api/rusender/account', requireAuth, async (req, res, next) => {
    try {
      const resolved = await resolveRusenderChannel(req, res, { optional: true });
      if (!resolved) return;
      if (!resolved.channel) {
        return res.status(404).json({ error: 'Rusender не подключён к этому каналу' });
      }
      if (!hasWorkspaceRole(resolved.channel, req.user, 'admin')) {
        return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
      }
      await db.deleteRusenderAccount(resolved.channel.id);
      await audit(req, 'rusender_disconnect', {
        channelId: resolved.channel.id,
        accountId: (resolved.acc && resolved.acc.account_id) || null,
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
}

module.exports = { registerRusenderRoutes, REQUIRED_SCOPES };
