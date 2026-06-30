import { describe, expect, it } from 'vitest';
import { cityName, countryName } from '@/lib/igMetrics';

describe('geo normalization', () => {
  it('cityName drops the region and localizes known RU/CIS cities', () => {
    expect(cityName('London, England')).toBe('London');
    expect(cityName('Moscow, Moscow')).toBe('Москва');
    expect(cityName('Yekaterinburg, Sverdlovsk Oblast')).toBe('Екатеринбург');
    expect(cityName('Москва, Москва')).toBe('Москва');
  });

  it('countryName resolves a code and passes non-codes through', () => {
    expect(countryName('US')).toBeTruthy();
    expect(countryName('Россия')).toBe('Россия');
  });
});
