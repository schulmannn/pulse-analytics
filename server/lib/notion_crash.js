// Fire-and-forget Notion sink for client crashes: one card per unique crash signature in the
// dedicated «Краши» database, repeats bump the «Повторов» counter. Soft-off unless BOTH
// NOTION_TOKEN (internal integration secret) and NOTION_CRASH_DB (the database id) are set — the
// /api/client-errors path already stores every crash in Postgres, so this is a pure add-on surface.
//
// Setup (once, by an operator):
//   1. Create a Notion internal integration → copy its secret.
//   2. Share the «Краши» database with that integration (••• → Connections).
//   3. Railway env: NOTION_TOKEN=<secret>, NOTION_CRASH_DB=<database id>.
const fetch = require('node-fetch');

const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_CRASH_DB = process.env.NOTION_CRASH_DB || '';
const NOTION_VERSION = '2022-06-28';
const enabled = !!(NOTION_TOKEN && NOTION_CRASH_DB);

async function notionFetch(path, method, body) {
  try {
    const r = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeout: 8000,
    });
    if (!r.ok) return null; // 4xx/5xx — telemetry is best-effort, never surfaced to the user
    return await r.json();
  } catch {
    return null; // network/timeout — swallow; the crash is already in Postgres
  }
}

/** Notion rich_text array from a scalar (empty array clears / omits the value). */
const rt = (v) => (v ? [{ type: 'text', text: { content: String(v).slice(0, 1900) } }] : []);

/** Create one card for a newly-seen crash signature. Returns the Notion page id (or null). */
async function createCrashCard(f) {
  if (!enabled) return null;
  const properties = {
    'Ошибка': { title: rt(`[${f.scope}] ${f.name}: ${f.message}`.slice(0, 180)) },
    'Статус': { select: { name: 'Новый' } },
    'Scope': { select: { name: f.scope } },
    'Повторов': { number: f.count || 1 },
    'Маршрут': { rich_text: rt(f.route) },
    'Виджет': { rich_text: rt(f.widgetId || f.label) },
    'Коммит': { rich_text: rt(f.commit) },
    'Trace-id': { rich_text: rt(f.traceId) },
    'Сигнатура': { rich_text: rt(f.signature) },
    'Впервые': { date: { start: f.at } },
    'Последний раз': { date: { start: f.at } },
  };
  const children = f.stack
    ? [{ object: 'block', type: 'code', code: { language: 'plain text', rich_text: rt(String(f.stack).slice(0, 1900)) } }]
    : [];
  const r = await notionFetch('/pages', 'POST', { parent: { database_id: NOTION_CRASH_DB }, properties, children });
  return r && r.id ? r.id : null;
}

/** Bump the repeat counter + last-seen on an existing card. */
async function updateCrashCard(pageId, f) {
  if (!enabled || !pageId) return;
  await notionFetch(`/pages/${pageId}`, 'PATCH', {
    properties: {
      'Повторов': { number: f.count },
      'Последний раз': { date: { start: f.at } },
      'Trace-id': { rich_text: rt(f.traceId) },
    },
  });
}

module.exports = { enabled, createCrashCard, updateCrashCard };
