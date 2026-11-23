import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapInstaller, shortInstallCommand } from '../cloud/install-command.mjs';
import { enrollmentBootstrapUrl, mergeEnrollmentBootstrapHistory,
  resolveEnrollmentBootstrap } from '../cloud/enrollment-bootstrap.mjs';

const origin = 'https://manager.example.invalid';
const release = (version, digest = 'a') => ({ version, browser: false,
  url: `https://releases.example.invalid/${version}/linux-x64.tgz`, sha256: digest.repeat(64) });
const options = (history, lookupApproved = (os, version) => history[os]?.[version]) => ({ origin, lookupApproved,
  render: (base, os, manifest) => JSON.stringify({ base, os, ...manifest }) });
const publicUrl = (version, asset = release(version)) => enrollmentBootstrapUrl(origin,
  { platform: 'linux', version, browser: false, assets: { x64: asset } });

test('the URL embedded in an existing command is public, immutable, and works after N+1', async () => {
  const old = release('1.0.0');
  const oldUrl = await publicUrl(old.version, old);
  const parsed = new URL(oldUrl);
  assert.equal(parsed.pathname, '/device/install/linux');
  assert.deepEqual([...parsed.searchParams.keys()], ['version', 'manifest']);
  const previous = mergeEnrollmentBootstrapHistory({}, { 'linux-x64': old });
  const latest = release('1.0.1', 'b');
  const advanced = mergeEnrollmentBootstrapHistory(JSON.parse(JSON.stringify(previous)), { 'linux-x64': latest });
  assert.equal(advanced.linux['1.0.1'].assets.x64.sha256, 'b'.repeat(64));
  const response = await resolveEnrollmentBootstrap(new Request(oldUrl), options(advanced));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const rendered = await response.json();
  assert.equal(rendered.version, old.version);
  assert.deepEqual(rendered.assets.x64, { url: old.url, sha256: old.sha256 });
});

test('same OS/version cannot be reassigned, even by an incorrect lookup at request time', async () => {
  const old = release('1.0.0');
  const previous = mergeEnrollmentBootstrapHistory({}, { 'linux-x64': old });
  const wrong = release('1.0.0', 'f');
  assert.throws(() => mergeEnrollmentBootstrapHistory(previous, { 'linux-x64': wrong }), /cannot be reassigned/);
  const response = await resolveEnrollmentBootstrap(new Request(await publicUrl(old.version)),
    options(previous, () => ({ version: old.version, assets: { x64: wrong } })));
  assert.equal(response.status, 404);
});

test('wrong OS cannot reuse pin; secret-bearing and duplicate query parameters never reach lookup', async () => {
  const oldUrl = await publicUrl('1.0.0');
  const history = mergeEnrollmentBootstrapHistory({}, { 'linux-x64': release('1.0.0') });
  const altered = oldUrl.replace('/linux?', '/macos?');
  assert.equal((await resolveEnrollmentBootstrap(new Request(altered), options(history, () => history.linux['1.0.0']))).status, 404);
  let calls = 0;
  for (const url of [oldUrl + '&ticket=never', oldUrl + '&version=1.0.0', oldUrl + '&manifest=bad']) {
    const observed = await resolveEnrollmentBootstrap(new Request(url), options(history, () => { calls++; }));
    assert.equal(observed.status, 404);
  }
  assert.equal(calls, 0);
  assert.equal(await resolveEnrollmentBootstrap(new Request(`${origin}/device/install/linux?version=1.0.0`),
    options(history)), undefined);
  assert.equal((await resolveEnrollmentBootstrap(new Request(oldUrl), { origin, lookupApproved: () => history.linux['1.0.0'] })).status, 404);
});

test('macOS, Windows and Linux short commands keep fetching their original approved scripts after a catalog upgrade', async () => {
  const platforms = [
    ['macos', 'arm64', 'tgz'],
    ['windows', 'x64', 'zip'],
    ['linux', 'x64', 'tgz'],
  ];
  const catalog = (version, hashes) => Object.fromEntries(platforms.map(([os, arch, ext], i) => [
    os + '-' + arch, { version, browser: false, sha256: hashes[i].repeat(64),
      url: 'https://releases.example.invalid/' + version + '/' + os + '-' + arch + '.' + ext },
  ]));
  const old = catalog('1.0.0', 'abc');
  const newer = catalog('1.0.1', 'def');
  const previous = mergeEnrollmentBootstrapHistory({}, old);
  const history = mergeEnrollmentBootstrapHistory(JSON.parse(JSON.stringify(previous)), newer);
  const route = {
    origin,
    lookupApproved: (os, version) => history[os]?.[version],
    render: (base, os, manifest) => bootstrapInstaller(base, os, manifest, { enrollmentIntent: true }),
  };

  for (const [os, arch] of platforms) {
    const entry = old[os + '-' + arch];
    const pin = await enrollmentBootstrapUrl(origin, { platform: os, ...entry, assets: { [arch]: entry } });
    const ticket = 't'.repeat(43);
    const deviceId = 'fixture-' + os;
    const command = shortInstallCommand(origin, os, entry.version, ticket, deviceId, { pinnedUrl: pin });
    const fetchTarget = command.match(/'(https:[^']+)'/)?.[1];
    assert.equal(fetchTarget, pin);
    assert.ok(!fetchTarget.includes(ticket) && !fetchTarget.includes(deviceId));
    assert.ok(command.includes("'" + ticket + "'") && command.includes("'" + deviceId + "'"));

    const response = await resolveEnrollmentBootstrap(new Request(fetchTarget), route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    const script = await response.text();
    const replacement = newer[os + '-' + arch];
    assert.ok(script.startsWith(os === 'windows' ? 'param(' : '#!/bin/sh'));
    assert.ok(script.includes('intent-v1') && script.includes(entry.url) && script.includes(entry.sha256));
    assert.ok(!script.includes(replacement.url) && !script.includes(replacement.sha256));
    assert.ok(!script.includes(ticket) && !script.includes(deviceId));

    const mismatched = new URL(fetchTarget);
    mismatched.searchParams.set('version', replacement.version);
    const blocked = await resolveEnrollmentBootstrap(new Request(mismatched), route);
    assert.equal(blocked.status, 404);
    assert.equal(await blocked.text(), 'Installer version unavailable.');
  }
});
