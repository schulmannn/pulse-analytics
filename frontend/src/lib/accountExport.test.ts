import { describe, expect, it, vi } from 'vitest';
import { fetchAccountExport } from './accountExport';

describe('account export auth boundary', () => {
  it('forwards a direct-fetch 401 to the shared browser redirect policy', async () => {
    const request = vi.fn(async () =>
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    const onUnauthorized = vi.fn(() => true);

    await expect(fetchAccountExport(request, onUnauthorized)).rejects.toThrow('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledWith({ status: 401 });
  });

  it('shows the server busy message instead of saving a broken file', async () => {
    const message = 'Сейчас уже идёт выгрузка данных — попробуйте через минуту';
    const request = vi.fn(async () =>
      Response.json(
        { error: message, retry_after: 60 },
        { status: 503, headers: { 'Retry-After': '60' } },
      ),
    );

    await expect(fetchAccountExport(request, () => false)).rejects.toThrow(message);
  });
});
