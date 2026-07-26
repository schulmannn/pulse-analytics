import { describe, expect, it, vi } from 'vitest';
import {
  redirectBrowserOnUnauthorized,
  shouldRedirectOnUnauthorized,
} from './authRedirect';

describe('shouldRedirectOnUnauthorized', () => {
  it('redirects a protected me refetch after its cookie expires', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/', false),
    ).toBe(true);
  });

  it('redirects a protected query 401 without depending on the ApiError class bundle', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/home', false),
    ).toBe(true);
  });

  it('redirects a mutation 401 (including logout) but leaves a 503 on the page', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/settings', false),
    ).toBe(true);
    expect(
      shouldRedirectOnUnauthorized({ status: 503 }, '/settings', false),
    ).toBe(false);
  });

  it('does not redirect login, demo, non-401 or unrelated errors', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/login', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/home', true),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 500 }, '/home', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized(new Error('offline'), '/home', false),
    ).toBe(false);
  });

  it('redirects direct browser fetches once and respects login/demo exemptions', () => {
    const assign = vi.fn();
    expect(
      redirectBrowserOnUnauthorized(
        { status: 401 },
        { pathname: '/settings', demoMode: false, assign },
      ),
    ).toBe(true);
    expect(assign).toHaveBeenCalledWith('/login');

    expect(
      redirectBrowserOnUnauthorized(
        { status: 401 },
        { pathname: '/login', demoMode: false, assign },
      ),
    ).toBe(false);
    expect(
      redirectBrowserOnUnauthorized(
        { status: 401 },
        { pathname: '/settings', demoMode: true, assign },
      ),
    ).toBe(false);
    expect(assign).toHaveBeenCalledOnce();
  });
});
