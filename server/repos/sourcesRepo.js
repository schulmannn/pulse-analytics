'use strict';

/* ── External sources repo (P2 db-split, PR 7.5, finding 8) ───────────────────────────────────────
   Дедуплицированная identity внешней площадки (external_sources: одна строка на (network, external_id),
   общая для всех воркспейсов). Это ОТДЕЛЬНЫЙ домен, а не часть channels: его делят channelsRepo
   (canonical-штамп канала), integrationsRepo (IG OAuth-source), collectorRepo (source_id в дневных
   строках) и analytics-ридеры (source-union). Раньше ensureExternalSource жил в channelsRepo и
   integrationsRepo брал его инъекцией ИЗ channels — семантическая связь channels↔integrations. Теперь
   обе зависят ОТ sourcesRepo, а не друг от друга (перед 3-й платформой эта развязка важна).

   Извлечено ДОСЛОВНО из channelsRepo — SQL не менялся. Зависит только от pool + enabled. Метод
   принимает `executor = pool` → работает и автокоммитом, и внутри чужой транзакции (executor-discipline). */

function createSourcesRepo({ pool, enabled }) {
  // Find-or-create the deduplicated identity of an external property.
  async function ensureExternalSource(network, externalId, { username, title } = {}, executor = pool) {
    if (!enabled || !network || externalId == null) return null;
    // Existing metadata WINS (fill NULLs only): the source row is shared across workspaces, so the
    // last-ingesting link must not keep overwriting the canonical username/title (metadata bleed).
    const { rows } = await executor.query(
      `INSERT INTO external_sources (network, external_id, username, title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (network, external_id) DO UPDATE SET
         username = COALESCE(external_sources.username, EXCLUDED.username),
         title    = COALESCE(external_sources.title, EXCLUDED.title)
       RETURNING id`,
      [network, String(externalId), username || null, title || null]);
    return rows[0] ? rows[0].id : null;
  }

  return { ensureExternalSource };
}

module.exports = { createSourcesRepo };
