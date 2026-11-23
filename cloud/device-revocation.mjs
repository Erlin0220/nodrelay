import { base64url } from 'jose';
import { tokenPattern } from './tickets.mjs';

const encoder = new TextEncoder();
const revocationMessage = (origin, deviceId) =>
  encoder.encode(JSON.stringify(['devspace-fleet/revoke/v1', origin, deviceId]));
const key = (token, usage) => crypto.subtle.importKey('raw',
  base64url.decode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function activationDigest(token) {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

export async function revokeResponse(origin, deviceId, token) {
  const proof = await crypto.subtle.sign('HMAC', await key(token, 'sign'), revocationMessage(origin, deviceId));
  return { status: 'revoked', deviceId, proof: base64url.encode(new Uint8Array(proof)) };
}

export async function confirmedRevocation(body, origin, deviceId, token) {
  if (body?.status !== 'revoked' || body.deviceId !== deviceId ||
      typeof body.proof !== 'string' || !tokenPattern.test(body.proof)) return false;
  return crypto.subtle.verify('HMAC', await key(token, 'verify'),
    base64url.decode(body.proof), revocationMessage(origin, deviceId));
}
