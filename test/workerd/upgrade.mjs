import { publicJwk } from './signed-fixture.mjs';
import { loadVerifiedUpgradeArtifacts } from './upgrade-artifacts.mjs';

async function load(scenario, format) {
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, 'Ed25519', false, ['verify']);
  return loadVerifiedUpgradeArtifacts({
    base: 'https://release.example.invalid/' + scenario + '/', channel: 'preview',
    currentVersion: '1.0.0-preview.1', publicKey, now: Date.parse('2026-11-01T12:00:00Z'), format,
  });
}

async function expectVersion(format) {
  const verified = await load('good', format);
  if (verified.release.version !== '1.0.0-preview.2') throw new Error('Unexpected verified upgrade');
}
async function expectFailure(scenario, format, expectedError) {
  try {
    await load(scenario, format);
  } catch (error) {
    if (expectedError.test(error.message)) return;
    throw error;
  }
  throw new Error('Redirect accepted by signed feed loader: ' + scenario);
}

export const verifiesSignedFeed = { test: () => expectVersion(1) };
export const fallsBackWhenV2IsAbsent = { test: () => expectVersion('auto') };
export const refusesManifestRedirect = { test: () => expectFailure('redirect', 1, /feed is unavailable/) };
export const refusesV2RedirectWithoutFallback = {
  test: () => expectFailure('bad-v2', 'auto', /v2 upgrade feed cannot be verified/),
};
