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
});
