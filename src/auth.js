import crypto from 'node:crypto';
import { getSetting, setSetting, deleteSetting } from './db.js';

/**
 * One household PIN, not a user system. It gates mutations (channel edits, rules,
 * settings, player control); the TV and read-only endpoints stay open. Sessions
 * are a stateless HMAC cookie so they survive restarts; rotating the secret (on
 * a new PIN or logout) invalidates them. Reset path: delete the `pin_hash` row
 * in settings.
 */

function authSecret() {
  let s = getSetting('auth_secret', null);
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('auth_secret', s);
  }
  return s;
}

export function isConfigured() {
  return !!getSetting('pin_hash', null);
}

export function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  setSetting('pin_hash', `${salt}:${hash}`);
  setSetting('auth_secret', crypto.randomBytes(32).toString('hex')); // invalidate old sessions
}

export function clearPin() {
  deleteSetting('pin_hash');
  deleteSetting('auth_secret');
}

export function verifyPin(pin) {
  const stored = getSetting('pin_hash', null);
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sessionToken() {
  return crypto.createHmac('sha256', authSecret()).update('ok').digest('hex');
}

export function tokenValid(token) {
  if (!token) return false;
  const want = sessionToken();
  return token.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
}

export function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)dumbtv_auth=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookieHeader() {
  return `dumbtv_auth=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

/** Headless setup for the Pi image: DUMBTV_PIN sets the PIN on first boot. */
export function initFromEnv() {
  const envPin = process.env.DUMBTV_PIN;
  if (envPin && /^\d{4,6}$/.test(envPin) && !isConfigured()) setPin(envPin);
}
