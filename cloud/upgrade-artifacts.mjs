import { verifyUpgradeRelease } from './upgrade-plan.mjs';

const maxBytes = { manifest: 64 * 1024, signature: 64, worker: 8 * 1024 * 1024 };

// Workers only implement follow/manual. Return any 3xx to the status check;
// never follow Location to a different release origin.
const downloadRequest = (url, request, signal) => request(url.href, {
    method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'omit', signal,
    headers: { Accept: 'application/octet-stream, application/json, text/javascript' },
});
async function download(url, max, request, signal, received) {
  const response = received ?? await downloadRequest(url, request, signal);
  const length = Number(response.headers.get('Content-Length'));
  if (response.status !== 200 || !response.body || length > max) {
    await response.body?.cancel();
    throw new Error('The Nodrelay upgrade feed is unavailable or returned an oversized artifact');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('The Nodrelay upgrade feed returned an oversized artifact');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

// The feed URL and key are trusted installation configuration, not request
// parameters. Never send Authorization, device data or Access headers to it.
export async function loadVerifiedUpgradeArtifacts({
  base, channel, currentVersion, publicKey, request = fetch, now = Date.now(), allowCurrent = false, format = 1,
}) {
  const directory = typeof base === 'string' && URL.parse(base);
  if (!directory || directory.protocol !== 'https:' || directory.username || directory.password ||
      directory.search || directory.hash || !directory.pathname.endsWith('/') || !['stable', 'preview'].includes(channel) ||
      (format !== 1 && format !== 2 && format !== 'auto')) {
    throw new Error('Invalid trusted Nodrelay upgrade feed configuration');
  }
  const transfer = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(15000), transfer.signal]);
  const path = (mode, filename) => new URL(channel + (mode === 2 ? '/v2/' : '/') + filename, directory);
  try {
    let received;
    if (format === 'auto') {
      const v2 = await downloadRequest(path(2, 'manifest.json'), request, signal);
      // Only an absent manifest denotes a not-yet-published v2 feed. HTTP or
      // signature failures never trigger fallback to an older release.
      if (v2.status === 404) {
        await v2.body?.cancel();
        format = 1;
      } else {
        if (v2.status !== 200) {
          await v2.body?.cancel();
          throw new Error('The Nodrelay v2 upgrade feed cannot be verified');
        }
        format = 2;
        received = v2;
      }
    }
    const [manifest, signature, bundle] = await Promise.all([
      download(path(format, 'manifest.json'), maxBytes.manifest, request, signal, received),
      download(path(format, 'manifest.json.sig'), maxBytes.signature, request, signal),
      download(path(format, 'worker.js'), maxBytes.worker, request, signal),
    ]);
    const verified = await verifyUpgradeRelease({ manifest, signature, bundle, publicKey, channel, currentVersion, now, allowCurrent, format });
    return { release: verified.release, ...(format === 2 && { manifestSha256: verified.manifestSha256 }),
      artifact: { manifest, signature, bundle: verified.bundle, publicKey, channel, ...(format === 2 && { format }) } };
  } catch (error) {
    // A failed manifest or signature must not leave a sibling download
    // running until its deadline after this request has already failed.
    transfer.abort();
    throw error;
  }
}
