'use strict';

// Собирает публичный фасад db.* из доменных частей и ПАДАЕТ на коллизии ключей. Раньше фасад
// строился через `{ ...usersRepo, ...channelsRepo, ...integrationsRepo, ... }`: если два repo
// экспортируют одно имя, последний spread молча побеждает — одна реализация тихо затирает другую.
// Здесь пересечение ключей — ошибка загрузки модуля (ловится boot-смоуком + контракт-тестом), то
// есть коллизия видна ДО деплоя, а не как «метод внезапно ведёт себя иначе».
//
// parts: { <partName>: <object> } — порядок не важен (disjoint по определению). Возвращает плоский
// объект со всеми ключами всех частей.
function mergeExports(parts) {
  const out = {};
  const owner = new Map();
  for (const [partName, part] of Object.entries(parts)) {
    for (const key of Object.keys(part)) {
      if (owner.has(key)) {
        throw new Error(`db facade collision: "${key}" экспортируют и ${owner.get(key)}, и ${partName}`);
      }
      owner.set(key, partName);
      out[key] = part[key];
    }
  }
  return out;
}

module.exports = { mergeExports };
