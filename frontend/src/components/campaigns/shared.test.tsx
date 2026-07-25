import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CampaignColorDot, campaignColorCss } from './shared';

// Контракт цвета кампании: сервер принимает токен темы chart-1..chart-6 ИЛИ легаси-hex #RRGGBB.
// campaignColorCss — единственный маппер значения в CSS; тест пинит обе ветки и null-safety,
// чтобы точки/свотчи не разъехались между CampaignsView, диалогами и metric-страницами.

describe('campaignColorCss', () => {
  it('maps every theme token chart-1..chart-6 to the categorical hsl var', () => {
    for (let n = 1; n <= 6; n++) {
      expect(campaignColorCss(`chart-${n}`)).toBe(`hsl(var(--chart-${n}-cat))`);
    }
  });

  it('passes legacy hex through unchanged', () => {
    expect(campaignColorCss('#2d6be0')).toBe('#2d6be0');
    expect(campaignColorCss('#B48A2F')).toBe('#B48A2F');
  });

  it('is null-safe and returns undefined for garbage', () => {
    expect(campaignColorCss(null)).toBeUndefined();
    expect(campaignColorCss(undefined)).toBeUndefined();
    expect(campaignColorCss('')).toBeUndefined();
    expect(campaignColorCss('red')).toBeUndefined();
    expect(campaignColorCss('chart-0')).toBeUndefined();
    expect(campaignColorCss('chart-7')).toBeUndefined();
    expect(campaignColorCss('CHART-3')).toBeUndefined();
    expect(campaignColorCss('#2d6be')).toBeUndefined();
  });
});

describe('CampaignColorDot', () => {
  it('paints a token campaign with the theme-adaptive hsl var', () => {
    const html = renderToStaticMarkup(<CampaignColorDot color="chart-2" />);
    expect(html).toContain('hsl(var(--chart-2-cat))');
  });

  it('paints a legacy hex campaign as before', () => {
    const html = renderToStaticMarkup(<CampaignColorDot color="#2d6be0" />);
    expect(html).toContain('#2d6be0');
  });

  it('renders the neutral hairline dot without inline style when color is absent', () => {
    const html = renderToStaticMarkup(<CampaignColorDot color={null} />);
    expect(html).not.toContain('style=');
    expect(html).toContain('border-border');
  });
});
