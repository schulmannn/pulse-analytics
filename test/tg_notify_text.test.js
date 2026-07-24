'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  webhookSecretOf,
  parseStartPayload,
  formatMentionCard,
  formatSeedMessage,
  formatOverflowMessage,
} = require('../server/lib/tgNotifyText');

test('escapeHtml neutralizes Bot-API HTML metacharacters', () => {
  assert.equal(escapeHtml('<b>&"</b>'), '&lt;b&gt;&amp;"&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('webhookSecretOf is stable, token-bound and Telegram-alphabet-safe', () => {
  const a = webhookSecretOf('123:abc');
  assert.equal(a, webhookSecretOf('123:abc'));            // стабилен между вызовами/рестартами
  assert.notEqual(a, webhookSecretOf('123:other'));       // другой токен → другой секрет
  assert.match(a, /^[a-f0-9]{64}$/);                      // hex укладывается в [A-Za-z0-9_-]{1,256}
  assert.equal(webhookSecretOf(''), '');
});

test('parseStartPayload accepts only well-formed /start deep-link payloads', () => {
  assert.equal(parseStartPayload('/start abc123DEF_-x'), 'abc123DEF_-x');
  assert.equal(parseStartPayload('/start@atlavue_bot abc123DEF_-x'), 'abc123DEF_-x');
  assert.equal(parseStartPayload('  /start abc123DEF_-x  '), 'abc123DEF_-x');
  assert.equal(parseStartPayload('/start'), null);                    // без payload
  assert.equal(parseStartPayload('/start short'), null);              // короче 8
  assert.equal(parseStartPayload('/start bad payload'), null);        // пробел внутри
  assert.equal(parseStartPayload('/start <script>alert</script>'), null);
  assert.equal(parseStartPayload('привет'), null);
  assert.equal(parseStartPayload(undefined), null);
});

test('formatMentionCard escapes user content and keeps the post link', () => {
  const card = formatMentionCard({
    title: 'Канал <b>про</b> всё',
    username: 'some_channel',
    snippet: 'Обзор бренда & «кавычки»',
    link: 'https://t.me/some_channel/42',
  });
  assert.match(card, /^🔔 <b>Канал &lt;b&gt;про&lt;\/b&gt; всё<\/b> \(@some_channel\)/);
  assert.match(card, /Обзор бренда &amp; «кавычки»/);
  assert.match(card, /https:\/\/t\.me\/some_channel\/42$/);
});

test('formatMentionCard tolerates missing optional fields', () => {
  assert.equal(formatMentionCard({ title: null }), '🔔 <b>канал</b>');
});

test('seed and overflow messages carry counts and the dashboard link', () => {
  assert.match(formatSeedMessage('nōtem', 155), /«nōtem»/);
  assert.match(formatSeedMessage('nōtem', 155), /нашёл 155 упоминаний/);
  assert.match(formatOverflowMessage(7, 'https://atlavue.app'), /ещё 7 новых/);
  assert.match(formatOverflowMessage(7, 'https://atlavue.app'), /https:\/\/atlavue\.app\/mentions/);
  assert.doesNotMatch(formatOverflowMessage(7, ''), /undefined|null/);
});
