import { describe, expect, it } from 'vitest';
import { igAccessStateOf } from './igAccessState';

const base = { channelId: 1, pending: [false, false, false], profileErrored: false };

describe('igAccessStateOf', () => {
  it('живой аккаунт: ни загрузки, ни ошибки, ни реконнекта', () => {
    expect(igAccessStateOf({ ...base, tokenState: 'ok' })).toEqual({ loading: false, error: false, reauth: false });
  });

  it('падение профиля — ошибка, даже если insights честно пустые', () => {
    // Регрессия того самого бага: прежнее правило требовало ОДНОВРЕМЕННОГО падения профиля и
    // insights, а сервер деградирует insights до пустого 200 — ошибка была недостижима.
    expect(igAccessStateOf({ ...base, profileErrored: true, tokenState: 'ok' })).toMatchObject({
      error: true,
      reauth: false,
    });
  });

  it('истёкший токен — reauth, и он старше загрузки', () => {
    const state = igAccessStateOf({ ...base, pending: [true, true, true], tokenState: 'expired' });
    expect(state).toEqual({ loading: false, error: false, reauth: true });
  });

  it('код ig_reauth с упавшего профиля тоже даёт reauth, а не общую ошибку', () => {
    const state = igAccessStateOf({ ...base, profileErrored: true, profileErrorCode: 'ig_reauth' });
    expect(state).toEqual({ loading: false, error: false, reauth: true });
  });

  it('токен на исходе — ещё рабочее состояние, экран не подменяется', () => {
    expect(igAccessStateOf({ ...base, tokenState: 'expiring' })).toEqual({ loading: false, error: false, reauth: false });
  });

  it('env-fallback без токена (token_state none) остаётся рабочим', () => {
    expect(igAccessStateOf({ ...base, tokenState: 'none' })).toEqual({ loading: false, error: false, reauth: false });
  });

  it('без канала запросы выключены: это пустота, а не вечная загрузка', () => {
    const state = igAccessStateOf({ ...base, channelId: null, pending: [true, true, true] });
    expect(state).toEqual({ loading: false, error: false, reauth: false });
  });

  it('обычная загрузка при известном канале', () => {
    expect(igAccessStateOf({ ...base, pending: [true, false, false] })).toMatchObject({ loading: true });
  });
});
