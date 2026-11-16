'use strict';

/**
 * Accounts: username + password. Passwords are hashed with scrypt (built into Node) and a random
 * salt; the plain password is never stored. Logged-in browsers hold a random session token in an
 * httpOnly cookie; the database only keeps a SHA-256 hash of it, so a leaked database can't be
 * used to log in.
 */

const crypto = require('node:crypto');
const { GameError } = require('./game');

const SESSION_COOKIE = 'poky_session';
const SESSION_DAYS = 60;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;

function cleanUsername(v) {
  const name = String(v ?? '').trim();
  if (!USERNAME_RE.test(name)) {
    throw new GameError('Usernames are 3–16 characters: letters, numbers, dots, dashes or underscores.');
  }
  return name;
}

/** Case-insensitive key, so "Aryan" and "aryan" are the same account. */
const usernameKey = (name) => name.toLowerCase();

function checkPassword(v) {
  const pw = String(v ?? '');
  if (pw.length < 6) throw new GameError('Passwords need at least 6 characters.');
  if (pw.length > 200) throw new GameError('That password is too long.');
  return pw;
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [kind, saltB64, keyB64] = String(stored).split('$');
  if (kind !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// A fixed hash to compare against when the username doesn't exist, so "no such user" and
// "wrong password" take the same time.
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
  return false;
}

const newSessionToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore a malformed cookie */
    }
  }
  return out;
}

/** Look up the logged-in user from a Cookie header (or null). */
async function userFromCookie(store, cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  try {
    return await store.findSession(hashToken(token));
  } catch (err) {
    console.error('Session lookup failed:', err.message);
    return null;
  }
}

/** Simple fixed-window limiter: at most `max` hits per key per `windowMs`. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      h = { start: now, count: 0 };
      hits.set(key, h);
    }
    h.count++;
    return h.count <= max;
  };
}

module.exports = {
  SESSION_COOKIE, SESSION_DAYS, cleanUsername, usernameKey, checkPassword, hashPassword, verifyPassword, dummyVerify,
  newSessionToken, hashToken, parseCookies, userFromCookie, rateLimiter,
};
