import { redirectBrowserOnUnauthorized } from '@/lib/authRedirect';

export async function fetchAccountExport(
  request: typeof fetch = fetch,
  onUnauthorized: (error: unknown) => boolean = redirectBrowserOnUnauthorized,
): Promise<Blob> {
  const response = await request('/api/account/export', {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    onUnauthorized({ status: response.status });
    let message = 'Не удалось выгрузить данные';
    try {
      const body: unknown = await response.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
      ) {
        message = body.error;
      }
    } catch {
      // Non-JSON response — keep the safe human fallback.
    }
    throw new Error(message);
  }
  return response.blob();
}
