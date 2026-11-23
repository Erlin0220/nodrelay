import { bundle, manifest, signedBase64 } from './signed-fixture.mjs';

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.hostname !== 'release.example.invalid' || request.headers.has('authorization') ||
        request.headers.has('cookie')) {
      throw new Error('Unexpected origin or credential forwarded to the fixture feed');
    }
    // Redirect to a working feed. Following it or falling back to v1 would
    // incorrectly return a successful upgrade instead of the expected error.
    if (['/redirect/preview/manifest.json', '/bad-v2/preview/v2/manifest.json'].includes(url.pathname)) {
      return Response.redirect('https://release.example.invalid/good/preview/manifest.json');
    }
    if (!/^\/(good|redirect|bad-v2)\/preview\/[^/]+$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    const artifacts = {
      'manifest.json': manifest,
      'manifest.json.sig': Uint8Array.from(atob(signedBase64), char => char.charCodeAt(0)),
      'worker.js': bundle,
    };
    return Object.hasOwn(artifacts, url.pathname.split('/').at(-1))
      ? new Response(artifacts[url.pathname.split('/').at(-1)])
      : new Response(null, { status: 404 });
  },
};
