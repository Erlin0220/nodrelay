import { base64url } from 'jose';

const text = new TextEncoder();
const parse = new TextDecoder();
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const devicePattern = /^[a-z][a-z0-9-]{0,23}$/;

const devicePort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;

// Loopback ports a device chose for its Portal-facing adapters. The Worker
// routes the device Tunnel to exactly these ports, so several Nodrelay
// instances on one host never compete for the same listeners.
export function validateDevicePorts(ports, browser) {
  const expected = browser ? ['browser', 'development'] : ['development'];
  if (ports === null || typeof ports !== 'object' || Array.isArray(ports) ||
      JSON.stringify(Object.keys(ports).sort()) !== JSON.stringify(expected) ||
      !expected.every(key => devicePort(ports[key])) || new Set(expected.map(key => ports[key])).size !== expected.length) {
    throw new Error('Invalid device ports');
  }
  return browser ? { development: ports.development, browser: ports.browser } : { development: ports.development };
}

export function validateCredentials(credentials) {
  if (typeof credentials?.deviceId !== 'string' || !devicePattern.test(credentials.deviceId) ||
      typeof credentials.portalToken !== 'string' || !tokenPattern.test(credentials.portalToken) ||
      typeof credentials.tunnelToken !== 'string' || !/^[A-Za-z0-9+/=_-]{32,4096}$/.test(credentials.tunnelToken)) {
    throw new Error('Invalid device identity or credentials');
  }
  const { deviceId, portalToken, tunnelToken } = credentials;
  if (credentials.activationToken === undefined) return { deviceId, portalToken, tunnelToken };
  if (typeof credentials.activationToken !== 'string' || !tokenPattern.test(credentials.activationToken) ||
      (credentials.browserToken !== undefined &&
        (typeof credentials.browserToken !== 'string' || !tokenPattern.test(credentials.browserToken)))) {
    throw new Error('Invalid device activation credential');
  }
  return { deviceId, portalToken, tunnelToken, activationToken: credentials.activationToken,
    ...(credentials.browserToken && { browserToken: credentials.browserToken }),
    ...(credentials.ports !== undefined && { ports: validateDevicePorts(credentials.ports, Boolean(credentials.browserToken)) }) };
}

async function key(secret) {
  if (typeof secret !== 'string' || !tokenPattern.test(secret)) throw new Error('Enrollment key is missing');
  return crypto.subtle.importKey('raw', base64url.decode(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
const digestOf = async ticket => base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(ticket))));
const time = () => Math.floor(Date.now() / 1000);

export async function issueTicket(db, secret, input) {
  const credentials = validateCredentials(input);
  const ticket = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await digestOf(ticket);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const now = time();
  const expiresAt = now + 600;
  const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(digest) },
    await key(secret), text.encode(JSON.stringify(credentials)));
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM enrollment_tickets WHERE expires_at <= ?').bind(now),
    db.prepare(`INSERT INTO enrollment_tickets (digest, device_id, expires_at, iv, payload)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO NOTHING`)
      .bind(digest, credentials.deviceId, expiresAt, base64url.encode(iv), base64url.encode(new Uint8Array(payload))),
  ]);
  return inserted.meta.changes === 1 ? { ticket, expiresAt } : undefined;
}

export async function redeemTicket(db, secret, ticket) {
  if (typeof ticket !== 'string' || !tokenPattern.test(ticket)) return;
  const decryptKey = await key(secret);
  const digest = await digestOf(ticket);
  const row = await db.prepare(`DELETE FROM enrollment_tickets WHERE digest = ? AND expires_at > ?
    RETURNING iv, payload`).bind(digest, time()).first();
  if (!row) return;
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: base64url.decode(row.iv), additionalData: text.encode(digest),
  }, decryptKey, base64url.decode(row.payload));
  return validateCredentials(JSON.parse(parse.decode(plaintext)));
}

export function ticketCancellation(db, deviceId) {
  if (typeof deviceId !== 'string' || !devicePattern.test(deviceId)) throw new Error('Invalid device id');
  return db.prepare('DELETE FROM enrollment_tickets WHERE device_id = ?').bind(deviceId);
}

export async function cancelTicket(db, deviceId) {
  if (typeof deviceId !== 'string' || !devicePattern.test(deviceId)) throw new Error('Invalid device id');
  const result = await db.prepare('DELETE FROM enrollment_tickets WHERE device_id = ? AND expires_at > ?')
    .bind(deviceId, time()).run();
  return result.meta.changes === 1;
}

export async function protect(secret, label, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(label) },
    await key(secret), text.encode(JSON.stringify(value)));
  return base64url.encode(iv) + '.' + base64url.encode(new Uint8Array(encrypted));
}

export async function unprotect(secret, label, value) {
  const [iv, cipher] = value.split('.');
  const clear = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: base64url.decode(iv), additionalData: text.encode(label),
  }, await key(secret), base64url.decode(cipher));
  return JSON.parse(parse.decode(clear));
}
