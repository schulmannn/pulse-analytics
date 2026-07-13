// ═══════════════════════════════════════════════════════════════
//  Atlavue — GDPR service (стирание и экспорт аккаунта, F4/F5)
// ═══════════════════════════════════════════════════════════════
// СЕРВИС, не repo (спека распила db.js, PR 8): erasure/export пересекают ВСЕ домены
// (users/channels/reports/integrations/архивы) — как repo это стало бы новым мини-god-
// module. Тела перенесены из db.js literal; SQL не менялся. Deps: pool (экспорт держит
// ОДИН выделенный коннект), transaction (общий BEGIN/COMMIT/ROLLBACK-хелпер db/core —
// та же семантика, что прежний inline-BEGIN), enabled.

'use strict';

function createGdprService({ pool, enabled, transaction }) {
  /* Полное стирание аккаунта (GDPR erasure) — один DELETE FROM users: реляционную полноту даёт
     схема. Каскадом умирают user_prefs / tg_sessions / email_tokens / reports / workspaces
     (+members) / channels(owner_uid), а от channels — все архивы (channel_daily / monthly /
     posts / mentions / velocity / ig_accounts / ig_daily / ig_media_daily / api_keys /
     annotations / snapshots). audit_events.uid и chart_annotations.created_by → SET NULL
     (журнал остаётся, но анонимный). Разделяемые external_sources НЕ трогаются — это identity
     публичного канала, не персональные данные.
     Pre-null: канал ДРУГОГО владельца, живущий в воркспейсе стираемого юзера (инвариант «канал
     в личном воркспейсе создателя» кодом не enforced), переводится в legacy NULL-workspace —
     owner_uid-fallback чтения жив с миграции 010; иначе NO ACTION FK на channels.workspace_id
     валит весь DELETE. */
  async function deleteUserAccount(uid) {
    if (!enabled || uid == null) return false;
    return transaction(async (client) => {
      await client.query(
        `UPDATE channels SET workspace_id = NULL
          WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_uid = $1)
            AND owner_uid IS DISTINCT FROM $1`, [uid]);
      // SET NULL анонимизирует только uid: исторические metadata несут прямые идентификаторы
      // (tg.session.connected — личный @username, ig_oauth_connected, channel.created) — без
      // зачистки «анонимный журнал» ложь (скептик-панель, erasure-completeness).
      await client.query(`UPDATE audit_events SET metadata = '{}'::jsonb WHERE uid = $1`, [uid]);
      const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [uid]);
      // Осиротевшие external_sources: для приватного канала username/title (часто имя человека)
      // не «shared identity» — если после каскада на источник не ссылается НИКТО, стираем и его.
      // Разделяемые источники (чужие channels/архивы ссылаются) переживают sweep невредимыми.
      await client.query(
        `DELETE FROM external_sources s
          WHERE NOT EXISTS (SELECT 1 FROM channels        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_accounts     t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM channel_daily   t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM channel_monthly t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM posts           t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM velocity_daily  t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM mentions        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_daily        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_media_daily  t WHERE t.source_id = s.id)`);
      return rowCount > 0;
    });
  }

  /* Экспорт персональных данных (GDPR portability) — один JSON-объект. Учётные данные не
     экспортируются НИКОГДА: pass_hash, token_version, tg_sessions.session_enc,
     ig_accounts.access_token_enc и key_hash не попадают в SELECT'ы. Каналы — только
     owner_uid=uid: шаренные воркспейс-каналы принадлежат другому владельцу (data minimization).
     Объём при текущем масштабе (кап 100 юзеров, архив ≤730 дн) — единицы МБ, буферизуем целиком. */
  async function exportUserData(uid) {
    if (!enabled || uid == null) return null;
    // GDPR-экспорт редкий, но тяжёлый (5 запросов на аккаунт + 9 на КАЖДЫЙ канал): его
    // Promise.all-фан-аут через pool.query занимал все PGPOOL_MAX=4 коннекта и душил
    // остальной API на время экспорта. Один выделенный клиент = ровно один коннект.
    // Запросы ПОСЛЕДОВАТЕЛЬНО (не Promise.all на одном клиенте): pg и так сериализует их на
    // соединении, но при отклонении одного Promise.all прыгал бы в finally→release() при ещё
    // живущих в очереди запросах — вернул бы в пул ЗАНЯТОЕ соединение (interleaving под нагрузкой).
    const client = await pool.connect();
    try {
      const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
      const many = async (sql, params) => (await client.query(sql, params)).rows;

      const account = await one(
        `SELECT id, email, role, status, avatar_url, created_at FROM users WHERE id=$1`, [uid]);
      if (!account) return null;

      const prefs = await one(`SELECT prefs, updated_at FROM user_prefs WHERE uid=$1`, [uid]);
      const reports = await many(`SELECT id, name, config, schedule, created_at, updated_at, last_sent_at
                FROM reports WHERE uid=$1 ORDER BY id`, [uid]);
      const workspaces = await many(`SELECT w.id, w.name, w.created_at,
                     (SELECT json_agg(json_build_object('uid', m.uid, 'role', m.role) ORDER BY m.uid)
                        FROM workspace_members m WHERE m.workspace_id = w.id) AS members
                FROM workspaces w WHERE w.owner_uid=$1 ORDER BY w.id`, [uid]);
      const tgSession = await one(`SELECT tg_user_id, username, connected_at, updated_at FROM tg_sessions WHERE uid=$1`, [uid]);
      const channels = await many(`SELECT id, username, title, source, tg_channel_id, created_at
                FROM channels WHERE owner_uid=$1 ORDER BY id`, [uid]);

      for (const ch of channels) {
        const daily = await many(`SELECT * FROM channel_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
        const monthly = await many(`SELECT month, subscribers_end, joins_sum, leaves_sum, views_sum, forwards_sum,
                         reactions_sum, days_count
                    FROM channel_monthly WHERE channel_id=$1 ORDER BY month`, [ch.id]);
        const posts = await many(`SELECT * FROM posts WHERE channel_id=$1 ORDER BY date_published`, [ch.id]);
        const mentionRows = await many(`SELECT * FROM mentions WHERE owner_channel_id=$1 ORDER BY msg_id`, [ch.id]);
        const velocity = await many(`SELECT * FROM velocity_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
        const annotations = await many(`SELECT day, label, created_at FROM chart_annotations WHERE channel_id=$1 ORDER BY day`, [ch.id]);
        const ig = await one(`SELECT ig_user_id, username, scopes, token_expires_at, connected_at, updated_at
                   FROM ig_accounts WHERE channel_id=$1`, [ch.id]);
        const igDaily = await many(`SELECT * FROM ig_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
        const igMedia = await many(`SELECT * FROM ig_media_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
        ch.archive = { daily, monthly, posts, mentions: mentionRows, velocity, annotations };
        ch.instagram = ig ? { ...ig, daily: igDaily, media_daily: igMedia } : null;
      }

      return {
        format: 'atlavue-export',
        version: 1,
        exported_at: new Date().toISOString(),
        account,
        prefs: prefs ? prefs.prefs : null,
        workspaces,
        reports,
        // Присутствие подключения — да; сама сессия — никогда (это credential, не данные).
        telegram_session: tgSession,
        channels,
      };
    } finally {
      client.release();
    }
  }

  return { deleteUserAccount, exportUserData };
}

module.exports = { createGdprService };
