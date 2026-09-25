#!/usr/bin/env node
/**
 * ГЕЙТ УЯЗВИМОСТЕЙ ФРОНТЕНДА поверх `npm audit --json`.
 *
 * Раньше здесь стоял `npx -y audit-ci@^7`. Он делает СВОЙ запрос к реестру и до сих пор ходит на
 * ретирящийся эндпоинт `/-/npm/v1/security/audits/quick`, который сам npm помечает как retiring:
 * 2026-09-04 три попытки подряд вернули «code undefined» за двадцать минут, гейт покраснел на всём
 * main, уязвимостей не было ни одной. Серверный шаг ту же беду вылечил установкой дерева перед
 * аудитом (#586) — npm тогда спрашивает поддерживаемый bulk-эндпоинт advisories. Здесь то же
 * лекарство не помогало, потому что запрос делает не npm, а audit-ci.
 *
 * Поэтому: спрашиваем сам `npm audit --json` (тот же bulk-эндпоинт, что и на сервере) и решаем
 * здесь. Заодно уходит `npx`-загрузка пакета на каждый прогон CI.
 *
 * ОТЛИЧАТЬ СБОЙ СЕТИ ОТ НАХОДКИ. `npm audit` даёт ненулевой код и когда нашёл уязвимость, и когда
 * не смог спросить реестр. Разбираем по выхлопу: есть валидный JSON с `vulnerabilities` — это
 * ответ реестра (пустой объект = чисто); нет — сетевой отказ, который ретраит вызывающий шаг.
 */
import { execFileSync } from 'node:child_process';

/**
 * GHSA-qwww-vcr4-c8h2 (react-router: CSRF в RSC-режиме) приложение не затрагивает: RSC/server-режим
 * react-router не используется (клиентский BrowserRouter поверх Express-статики, RSC-API в коде
 * нет), а фикс существует только в мажоре v8. Снять при бампе react-router-dom на исправленную
 * версию — Dependabot предложит.
 */
const ALLOWLIST = new Set(['GHSA-qwww-vcr4-c8h2']);
const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--json', '--omit=dev'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // Ненулевой код — норма при находках: отчёт всё равно в stdout.
    return err.stdout ?? '';
  }
}

const raw = runAudit();
let report;
try {
  report = JSON.parse(raw);
} catch {
  report = null;
}

if (report == null || typeof report.vulnerabilities !== 'object' || report.vulnerabilities == null) {
  console.error('реестр npm не ответил отчётом — это сетевой отказ, а не находка');
  console.error(raw.slice(0, 2000));
  process.exit(75); // EX_TEMPFAIL: вызывающий шаг ретраит именно этот код
}

/** Плоский список advisories: `via` держит либо объект-находку, либо имя пакета-транзитива. */
const found = new Map();
for (const entry of Object.values(report.vulnerabilities)) {
  for (const via of entry.via ?? []) {
    if (typeof via !== 'object' || !via.url) continue;
    const id = via.url.split('/').pop() ?? via.url;
    if (!BLOCKING.has(String(via.severity).toLowerCase())) continue;
    found.set(id, { id, name: via.name ?? entry.name, title: via.title ?? '', severity: via.severity, url: via.url });
  }
}

const blocking = [...found.values()].filter((a) => !ALLOWLIST.has(a.id));
const muted = [...found.values()].filter((a) => ALLOWLIST.has(a.id));

for (const a of muted) console.log(`allowlist: ${a.id} ${a.name} — ${a.title}`);
if (blocking.length === 0) {
  console.log(`npm audit: уязвимостей уровня high и выше нет (проверено пакетов: ${report.metadata?.dependencies?.total ?? '?'})`);
  process.exit(0);
}
for (const a of blocking) console.error(`${a.severity}: ${a.id} ${a.name} — ${a.title} (${a.url})`);
console.error(`::error::npm audit нашёл ${blocking.length} уязвимост(ь/и) уровня high и выше`);
process.exit(1);
