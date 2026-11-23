import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { profiles } from '../src/config.mjs';
import { call, connect, device, fixtureBackend, listen, PORTAL_TOKEN, result } from './helpers.mjs';

const driver = process.env.FLEET_TEST_PLAYWRIGHT;
test('Fleet browser adapters isolate real Chromium browser contexts', { skip: !driver, timeout: 30000 }, async t => {
  assert.ok(isAbsolute(driver), 'Set FLEET_TEST_PLAYWRIGHT to an installed Playwright module');
  const { chromium } = await import(pathToFileURL(driver).href);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const origin = await listen(t, createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Fleet fixture</title><input id="memo" aria-label="Scratch"><main id="status"></main>');
  }));
  async function isolatedBackend(id, token) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const backend = await fixtureBackend(t, [...profiles.browser.tools, 'browser_type'], async ({ name, arguments: args }) => {
      if (name === 'browser_profiles') return result({ profiles: [id] });
      if (args.browser_profile !== id) return { isError: true, content: [{ type: 'text', text: 'Profile does not belong to this device.' }] };
      if (name === 'browser_navigate') {
        assert.equal(args.url, origin);
        await page.goto(origin);
      } else if (name === 'browser_type') {
        await page.getByLabel('Scratch').fill(args.text);
        await page.evaluate(() => localStorage.setItem('memo', document.querySelector('#memo').value));
      }
      return result({
        value: await page.getByLabel('Scratch').inputValue(),
        saved: await page.evaluate(() => localStorage.getItem('memo')),
      });
    }, { stateless: true });
    const adapter = await device(t, backend.url, 'browser', { deviceId: id, portalToken: token });
    return connect(t, adapter.url, token);
  }
  const [first, second] = await Promise.all([
    isolatedBackend('fixture-a', PORTAL_TOKEN), isolatedBackend('fixture-b', 'p'.repeat(43)),
  ]);
  const go = (client, browser_profile) => call(client, 'browser_navigate', { browser_profile, url: origin });
  assert.deepEqual((await call(first, 'browser_profiles', {})).structuredContent.profiles, ['fixture-a']);
  assert.deepEqual((await call(second, 'browser_profiles', {})).structuredContent.profiles, ['fixture-b']);
  await Promise.all([go(first, 'fixture-a'), go(second, 'fixture-b')]);
  assert.equal((await call(second, 'browser_type', { browser_profile: 'fixture-a', text: 'bad' })).isError, true);
  const written = await call(first, 'browser_type', { browser_profile: 'fixture-a', text: 'local state' });
  assert.deepEqual(written.structuredContent, { value: 'local state', saved: 'local state' });
  const independent = await call(second, 'browser_snapshot', { browser_profile: 'fixture-b' });
  assert.deepEqual(independent.structuredContent, { value: '', saved: null });
});
