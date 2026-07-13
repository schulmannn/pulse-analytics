// ═══════════════════════════════════════════════════════════════
//  Atlavue — lifecycle (main)
// ═══════════════════════════════════════════════════════════════
// Оркестрация запуска: validateConfig → await bootPromise (миграции/бутстрап ДО
// открытия порта) → listen → return runtime{stop()}. index.js строит config/deps/app
// на module-load (как раньше) и остаётся entry (`node server/index.js` → main()).
// process.on-сигналы здесь НЕ вешаются — graceful shutdown приходит отдельным PR (E).

'use strict';

const { validateConfig, ConfigError } = require('./config');
const db = require('./db');
const { log } = require('./lib/observability');

// main({ port }) — port-override только для тестов (main({port:0}) = эфемерный порт);
// прод зовёт без аргументов и слушает config.http.port. Возвращает runtime {app,
// server, config, stop}; stop() идемпотентен (закрыть сервер + пул БД).
async function main({ port } = {}) {
  // index.js на require строит config+deps+app и СТАРТУЕТ boot-цепочку БД (fire-and-
  // forget, как раньше); main её дожидается перед listen.
  const { app, config, bootPromise } = require('./index');

  // Boot-fatal конфиг-чек (бывший inline-блок index.js §133-159, теперь validateConfig:
  // те же условия SESSION_SECRET/MTPROTO + инварианты порта/реплик/https). Prod: громкий
  // баннер + ConfigError (сообщения без значений секретов). Dev: мягкие warn'ы, boot
  // продолжается — как раньше (старый блок в dev молчал).
  const errors = validateConfig(config);
  if (errors.length) {
    if (config.isProduction) {
      console.error([
        '════════════════════════════════════════════════════════════════════',
        '[boot] FATAL: невалидная конфигурация в production.',
        ...errors.map((e) => `[boot] ${e.field}: ${e.message}`),
        '════════════════════════════════════════════════════════════════════',
      ].join('\n'));
      throw new ConfigError(errors);
    }
    for (const e of errors) console.warn(`[boot:dev] config: ${e.field}: ${e.message}`);
  }

  // Миграции/бутстрап/claim ДО открытия порта. `npm start` уже прогнал migrate.js
  // отдельным процессом — здесь идемпотентный no-op + bootstrapAdmin/claimOwnerChannel.
  // Цепочка не reject'ится (сбой БД → db_init_failed внутри, dbReady=false) — сервер
  // поднимается и в деградированном виде: health 200, ready 503.
  await bootPromise;

  // Single-replica guardrail (ops/ADR-002-single-replica.md). Response cache, igInflight
  // singleflight and the express-rate-limit stores are all in-process — correct only at
  // ONE web replica. Railway doesn't expose the replica count to the app, so the operator
  // declares it via WEB_REPLICAS; bumping Railway's replica slider WITHOUT the Redis-backed
  // shared state (still unbuilt) silently multiplies rate limits and Graph/MTProto quota
  // burn. Loud boot error = the tripwire for that scale-up.
  const WEB_REPLICAS = config.runtime.webReplicas;
  if (Number.isFinite(WEB_REPLICAS) && WEB_REPLICAS > 1) {
    log('error', 'multi_replica_unsupported', {
      web_replicas: WEB_REPLICAS,
      reason: 'in-process cache + rate-limit + singleflight are per-instance; needs shared (Redis) store first — see ops/ADR-002-single-replica.md',
    });
  }

  const listenPort = port != null ? port : config.http.port;
  const server = app.listen(listenPort);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);   // EADDRINUSE и т.п. → main отклоняется → exit(1) в entry
  });
  console.log(`
╔══════════════════════════════════════════╗
║        Atlavue Server            ║
╠══════════════════════════════════════════╣
║  URL:      http://localhost:${listenPort}          ║
║  IG API:   ${config.instagram.accessToken ? '✅ настроен' : '❌ не задан (IG_ACCESS_TOKEN)'}           ║
║  TG API:   ${config.telegram.botToken ? '✅ настроен' : '❌ не задан (TG_BOT_TOKEN)'}             ║
║  Sessions: ${config.auth.sessionSecret ? '✅ SESSION_SECRET задан' : '⚠️ ephemeral (dev) — задай SESSION_SECRET'}  ║
║  MTProto:  ${config.telegram.mtprotoToken ? '✅ MTPROTO_TOKEN задан' : '❌ MTPROTO_TOKEN не задан'}       ║
╚══════════════════════════════════════════╝
  `);

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => server.close(resolve));
    await db.close().catch(() => {});
  }

  return { app, server, config, stop };
}

module.exports = { main };
