import crypto from 'node:crypto';
import { readToken } from './auth.js';

// Acces temporaire de test demande : n'importe quel compte connecte peut
// utiliser 00999 dans Coupons. Aucun secret de signature n'est envoye au client.
const ttl = 30 * 60 * 1000;
const enabled = () => process.env.ADMIN_TEST_ACCESS_ENABLED !== 'false';
const codeValue = () => process.env.ADMIN_TEST_ACCESS_CODE || '00999';
const digest = value => crypto.createHash('sha256').update(value).digest();
const same = (a,b) => crypto.timingSafeEqual(digest(a),digest(b));
const bearer = req => String(req.headers.authorization || '').replace(/^Bearer /,'');
const signature = payload => crypto.createHmac('sha256',process.env.TOKEN_SECRET)
  .update('maf-admin-test|' + codeValue() + '|' + payload).digest('base64url');

export function createTestAdminAccess(req, code) {
  if (!enabled() || typeof code !== 'string' || !same(code.trim(),codeValue())) return null;
  const session = readToken(bearer(req));
  if (!session || session.uid !== req.userId) return null;
  const expires_at = Math.min(Date.now()+ttl,session.exp);
  const payload = Buffer.from(JSON.stringify({purpose:'maf-admin-test',uid:req.userId,
    exp:expires_at,sid:digest(bearer(req)).toString('hex')})).toString('base64url');
  return { token:payload+'.'+signature(payload), expires_at };
}

export function adminActor(req) {
  const apiKey = process.env.ADMIN_API_KEY || '';
  const given = String(req.headers['x-admin-key'] || '');
  if (apiKey.length >= 32 && given && same(apiKey,given)) return 'admin:api-key';
  const token = req.headers['x-admin-session'];
  if (!enabled() || typeof token !== 'string' || token.length > 2048) return null;
  const parts=token.split('.');
  if (parts.length !== 2 || !same(signature(parts[0]),parts[1])) return null;
  try {
    const data=JSON.parse(Buffer.from(parts[0],'base64url').toString());
    const session=readToken(bearer(req));
    if (data.purpose !== 'maf-admin-test' || !Number.isSafeInteger(data.uid) ||
        !Number.isFinite(data.exp) || data.exp <= Date.now() ||
        !session || session.uid !== data.uid || data.sid !== digest(bearer(req)).toString('hex')) return null;
    return 'admin:test-user:'+data.uid;
  } catch { return null; }
}
