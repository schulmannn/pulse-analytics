import { describe, expect, it } from 'vitest';
import { FEED_ROUTES } from './nav';

describe('FEED_ROUTES — feed pages suppress the shared Atlavue topbar', () => {
  // МойСклад analysis pages render their own FeedBlock header (like TG/IG). If their routes are
  // absent here, DashboardLayout's Topbar renders a duplicate title + divider over them.
  it('covers every MoySklad analysis page', () => {
    for (const route of ['/sklad', '/sklad/clients', '/sklad/channels']) {
      expect(FEED_ROUTES).toContain(route);
    }
  });

  it('still covers the TG and IG feed routes (no regression)', () => {
    for (const route of ['/', '/analytics', '/posts', '/mentions', '/instagram', '/instagram/audience']) {
      expect(FEED_ROUTES).toContain(route);
    }
  });
});
