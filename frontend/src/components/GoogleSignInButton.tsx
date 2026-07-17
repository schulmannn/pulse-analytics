import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfig, useGoogleLogin } from '@/api/queries';
import { ApiError } from '@/api/client';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface GsiId {
  initialize(cfg: { client_id: string; callback: (r: { credential?: string }) => void }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
function gsi(): GsiId | null {
  const g = (window as unknown as { google?: { accounts?: { id?: GsiId } } }).google;
  return g?.accounts?.id ?? null;
}

/** Load Google Identity Services once (idempotent); resolves when `google.accounts.id` is ready. */
function loadGsi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (gsi()) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('gsi')));
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('gsi'));
    document.head.appendChild(s);
  });
}

/**
 * "Sign in with Google" — the official GIS button. On the returned credential (an ID token) it
 * exchanges it for our own session via the useGoogleLogin mutation. Renders nothing until the
 * server exposes a Google client id (GOOGLE_CLIENT_ID), so the feature is inert until configured.
 */
export function GoogleSignInButton({ text = 'continue_with' }: { text?: 'continue_with' | 'signin_with' | 'signup_with' }) {
  const config = useConfig();
  const googleLogin = useGoogleLogin();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [loadErr, setLoadErr] = useState(false);
  const clientId = config.data?.google_client_id ?? null;

  useEffect(() => {
    if (!clientId || !ref.current) return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        const id = gsi();
        if (cancelled || !id || !ref.current) return;
        id.initialize({
          client_id: clientId,
          callback: (resp) => {
            if (resp.credential) googleLogin.mutate(resp.credential, { onSuccess: () => navigate('/') });
          },
        });
        const host = ref.current;
        host.innerHTML = '';
        // The auth card owns horizontal padding, so a fixed 320px GIS button can overflow on a
        // narrow viewport. Google accepts an explicit pixel width; cap it at the old desktop size
        // while respecting the actual host width on first render.
        const width = Math.min(320, Math.floor(host.clientWidth) || 320);
        id.renderButton(host, { theme: 'outline', size: 'large', shape: 'pill', text, width, locale: 'ru' });
      })
      .catch(() => setLoadErr(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  if (!clientId) return null; // inert until GOOGLE_CLIENT_ID is set on the server

  const err =
    googleLogin.error instanceof ApiError
      ? googleLogin.error.message
      : loadErr
        ? 'Не удалось загрузить Google'
        : null;

  return (
    <div className="mt-5">
      <div className="mb-4 flex items-center gap-3 text-sm text-ink3">
        <span className="h-px flex-1 bg-border" />
        или
        <span className="h-px flex-1 bg-border" />
      </div>
      <div ref={ref} className="flex min-h-[40px] justify-center" />
      {err && <p className="mt-2 text-center text-sm text-destructive">{err}</p>}
    </div>
  );
}
