'use strict';

const { tenantChannelId } = require('../middleware/tenant');

/**
 * ОБЩИЙ РЕЗОЛВ КАНАЛА И УЧЁТКИ для источников с подключением по секрету (аудит #554, «шесть
 * источников, три поколения паттернов»).
 *
 * МойСклад, Яндекс.Метрика и Rusender держали по своей копии одной функции: тенант-канал →
 * ownership-предикат → строка учётки → 403/404. Комментарии в каждой честно писали «зеркало
 * resolveMs» — то есть авторы знали, что копируют, и всё равно копировали, потому что положить
 * было некуда.
 *
 * Копии успели разойтись в ОДНОМ месте, и не в лучшем: у Rusender не было гейта `db.enabled`.
 * При недоступной базе МойСклад и Метрика честно отвечают 503 «База данных недоступна», а
 * Rusender отвечал 404 «не подключён к этому каналу» — то есть врал про состояние подключения
 * там, где не работало вообще ничего. Общий резолв закрывает это тем, что гейт в нём один.
 *
 * СДЭК сюда НЕ ВХОДИТ осознанно: у его источника нет ни токена, ни учётки — он существует
 * потому, что его создали, — и резолв там проверяет `source === 'cdek'` и роль в воркспейсе.
 * Это другая форма, и сводить её к этой значило бы придумать общее там, где его нет.
 */

/**
 * @param {object} deps
 * @param {object} deps.db фасад БД (нужны `enabled`, `getChannelOrDefault` и ридер учётки).
 * @param {(channelId: number) => Promise<object|null>} deps.getAccount ридер строки учётки.
 * @param {string} deps.secretField поле со ЗАШИФРОВАННЫМ секретом: его наличие и означает
 *   «подключено». Токен здесь не расшифровывается — резолв ничего не знает о крипте.
 * @param {string} deps.notConnected сообщение 404 на языке источника («МойСклад не подключён…»).
 * @returns {(req, res, opts?: { optional?: boolean }) => Promise<{channel, acc}|null>}
 *   null означает, что ответ УЖЕ отправлен.
 */
function makeResolveSourceChannel({ db, getAccount, secretField, notConnected }) {
  /**
   * `optional` (status/disconnect) смягчает ТОЛЬКО исходы «не подключён»: нет каналов или нет
   * учётки → `{ channel?, acc: null }` вместо 404, чтобы status честно ответил connected:false.
   * Явно запрошенный чужой канал — 403 ВСЕГДА, в том числе при `optional`: иначе ответ выдавал
   * бы существование чужого канала.
   */
  return async function resolveSourceChannel(req, res, { optional = false } = {}) {
    if (!db.enabled) {
      res.status(503).json({ error: 'База данных недоступна' });
      return null;
    }
    const wanted = tenantChannelId(req);
    const channel = await db.getChannelOrDefault(wanted, req.user).catch(() => null);
    if (!channel) {
      if (wanted) {
        res.status(403).json({ error: 'Нет доступа к этому каналу' });
        return null;
      }
      if (optional) return { channel: null, acc: null };
      res.status(404).json({ error: notConnected });
      return null;
    }
    const acc = await getAccount(channel.id).catch(() => null);
    if (!acc || !acc[secretField]) {
      if (optional) return { channel, acc: null };
      res.status(404).json({ error: notConnected });
      return null;
    }
    return { channel, acc };
  };
}

module.exports = { makeResolveSourceChannel };
