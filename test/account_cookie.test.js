'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAccountRoutes } = require('../server/routes/account');
const { serializeSessionCookie } = require('../server/lib/auth');

test('successful self-delete clears the HttpOnly session cookie server-side', async () => {
  const routes = new Map();
  const app = {
    get() {},
    put() {},
    post() {},
    patch() {},
    delete(path, ...handlers) {
      routes.set(path, handlers);
    },
  };
  const pass = (_req, _res, next) => next();
  registerAccountRoutes({
    app,
    requireAuth: pass,
    requireSuper: pass,
    db: {
      enabled: true,
      deleteUserAccount: async () => true,
    },
    audit: async () => {},
    sendEmail: async () => {},
    emailShell: () => '',
    GOOGLE_CLIENT_ID: null,
    clearSessionCookie: (req, res) => {
      res.append(
        'Set-Cookie',
        serializeSessionCookie('', { secure: req.secure, maxAgeMs: 0 }),
      );
    },
  });

  const handler = routes.get('/api/account').at(-1);
  const res = {
    headers: {},
    append(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await handler({
    secure: false,
    body: { confirm: 'user@example.com' },
    user: { uid: 7, email: 'user@example.com', role: 'user' },
  }, res, (error) => {
    throw error;
  });

  assert.deepEqual(res.body, { ok: true });
  assert.equal(
    res.headers['set-cookie'],
    'pulse_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  );
});
