import { describe, expect, it } from 'vitest';
import { PagePeriodControl } from '@/components/PeriodChips';
import { NETWORKS } from '@/lib/networks';
import { FEEDS } from '@/panels/feed/feeds';

/**
 * Период ленты меняется ОДНИМ контролом у всех сетей. Раньше у TG и IG было по своей дословной копии
 * (TgPagePeriodControl и IgPeriodControl), и любая правка чипов периода обязана была помнить про обе.
 * Тест проверяет инвариант, а не список: новая сеть или секция со своим контролом периода валит прогон.
 *
 * Единственное исключение — «Упоминания» TG: там тот же контрол обёрнут в desktop-only контейнер
 * (на телефоне шапка упоминаний прежняя, мобильный этап её не трогает).
 */
describe('лента — один контрол периода', () => {
  for (const net of NETWORKS) {
    for (const section of FEEDS[net.key].sections) {
      if (!section.HeaderRight) continue;
      const route = `${net.key}:${section.section || '/'}`;
      if (net.key === 'tg' && section.section === 'mentions') continue;
      it(route, () => {
        expect(section.HeaderRight).toBe(PagePeriodControl);
      });
    }
  }

  it('у каждой сети с периодом он есть хотя бы в одной секции', () => {
    for (const net of NETWORKS) {
      expect(FEEDS[net.key].sections.some((section) => section.HeaderRight === PagePeriodControl), net.key).toBe(true);
    }
  });
});
