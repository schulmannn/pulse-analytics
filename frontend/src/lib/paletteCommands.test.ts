import { describe, expect, it } from 'vitest';
import {
  availableNetworks,
  buildIgMetricCommands,
  buildNetworkRouteCommands,
  buildSourceCommands,
  channelDisplayName,
  type PaletteChannel,
} from '@/lib/paletteCommands';

// Один канал каждой сети реестра. Совместимость определяется РЕЕСТРОМ (lib/networks → hasChannel):
// tg — любой канал без source ig/ms/ym; ig — только ig_connected; ms/ym — ровно свой source.
const TG: PaletteChannel = { id: 1, username: 'tg_only' };
const IG: PaletteChannel = { id: 2, username: 'ig_only', source: 'ig', ig_connected: true };
const MS: PaletteChannel = { id: 3, title: 'Мой склад', source: 'ms' };
const YM: PaletteChannel = { id: 4, title: 'Сайт', source: 'ym' };
/** ТГ-канал с прилинкованным Instagram — единственный случай двух источников у одного канала. */
const TG_WITH_IG: PaletteChannel = { id: 5, username: 'both', ig_connected: true };

const ALL = [TG, IG, MS, YM];
const netsOf = (channelId: number, channels: PaletteChannel[] = ALL) =>
  buildSourceCommands(channels)
    .filter((c) => c.channelId === channelId)
    .map((c) => c.network.key);

describe('buildSourceCommands', () => {
  it('канал каждой сети получает команды ТОЛЬКО совместимых сетей', () => {
    expect(netsOf(TG.id)).toEqual(['tg']);
    expect(netsOf(IG.id)).toEqual(['ig']);
    expect(netsOf(MS.id)).toEqual(['ms']);
    expect(netsOf(YM.id)).toEqual(['ym']);
  });

  it('несовместимые сети отсутствуют — регрессия «Метрика/МойСклад у телеграм-канала»', () => {
    const ids = buildSourceCommands(ALL).map((c) => c.id);
    expect(ids).toEqual(['source:tg:1', 'source:ig:2', 'source:ms:3', 'source:ym:4']);
    for (const forbidden of ['source:ig:1', 'source:ms:1', 'source:ym:1', 'source:tg:2', 'source:tg:3']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it('ТГ-канал с прилинкованным IG — обе сети, в порядке реестра', () => {
    expect(netsOf(TG_WITH_IG.id, [TG_WITH_IG, MS])).toEqual(['tg', 'ig']);
  });

  it('подпись и имя канала: @username → title → id', () => {
    const [tg] = buildSourceCommands([TG, MS]);
    expect(tg.label).toBe('@tg_only · Telegram');
    expect(channelDisplayName({ id: 7 })).toBe('7');
    expect(channelDisplayName({ id: 7, title: 'Заголовок' })).toBe('Заголовок');
  });

  it('меньше двух каналов — группы источников нет', () => {
    expect(buildSourceCommands([TG])).toEqual([]);
    expect(buildSourceCommands([])).toEqual([]);
  });
});

describe('buildNetworkRouteCommands', () => {
  it('только ТГ-канал — разделы только Telegram', () => {
    const paths = buildNetworkRouteCommands([TG]).map((c) => c.path);
    expect(paths).toEqual(['/', '/analytics', '/posts', '/mentions']);
  });

  it('только МойСклад — разделы только МойСклада (без телеграмных)', () => {
    const commands = buildNetworkRouteCommands([MS]);
    expect(commands.map((c) => c.path)).toEqual(['/sklad', '/sklad/clients', '/sklad/channels']);
    // Не-дефолтная сеть подписывается своим именем, дефолтная (беспрефиксная) — нет.
    expect(commands[0].label).toBe('МойСклад · Обзор');
    expect(buildNetworkRouteCommands([TG])[0].label).toBe('Обзор');
  });

  it('IG-разделы появляются только при подключённом Instagram', () => {
    expect(buildNetworkRouteCommands([TG, MS]).map((c) => c.path)).not.toContain('/instagram');
    expect(buildNetworkRouteCommands([TG_WITH_IG]).map((c) => c.path)).toContain('/instagram');
  });

  it('Метрика тоже попадает в палитру (раньше её маршрута там не было вовсе)', () => {
    expect(buildNetworkRouteCommands([YM]).map((c) => c.path)).toEqual(['/metrika']);
  });

  it('каналы ещё не доехали — показываем все сети, палитра не пустеет', () => {
    expect(availableNetworks([]).map((n) => n.key)).toEqual(['tg', 'ig', 'ms', 'ym']);
    expect(buildNetworkRouteCommands([]).map((c) => c.path)).toContain('/instagram');
  });

  it('search несёт латинские синонимы, чтобы прежние запросы находили то же самое', () => {
    const overview = buildNetworkRouteCommands([TG]).find((c) => c.path === '/');
    expect(overview?.search).toContain('overview');
    const analytics = buildNetworkRouteCommands([TG]).find((c) => c.path === '/analytics');
    expect(analytics?.search).toContain('analytics');
  });
});

describe('buildIgMetricCommands', () => {
  it('без Instagram IG-метрик нет', () => {
    expect(buildIgMetricCommands([TG, MS, YM])).toEqual([]);
  });

  it('с Instagram — весь числовой drill-набор', () => {
    const keys = buildIgMetricCommands([TG_WITH_IG]).map((c) => c.key);
    expect(keys).toEqual([
      'ig-reach',
      'ig-follows',
      'ig-views',
      'ig-interactions',
      'ig-likes',
      'ig-saves',
      'ig-er',
    ]);
  });
});
