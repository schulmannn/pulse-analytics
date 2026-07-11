// Mint a session token OUTSIDE the server (load tests, ops smoke) — same HMAC contract as
// server/lib/auth.js signSession. Requires the SAME SESSION_SECRET the target server runs with.
//
//   SESSION_SECRET=… node ops/mint-token.mjs <uid> [role] [ttlHours]
import crypto from 'node:crypto';

const secret = process.env.SESSION_SECRET;
const uid = parseInt(process.argv[2], 10);
const role = process.argv[3] || 'user';
const ttlHours = Number(process.argv[4] || 12);
if (!secret || !Number.isInteger(uid)) {
  console.error('usage: SESSION_SECRET=… node ops/mint-token.mjs <uid> [role] [ttlHours]');
  process.exit(1);
}
const body = Buffer.from(JSON.stringify({ uid, role, exp: Date.now() + ttlHours * 3600_000, ver: 0 }))
  .toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
console.log(`${body}.${sig}`);
