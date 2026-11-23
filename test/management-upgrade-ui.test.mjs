import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { consoleScript, consoleUpgradeScript } from '../cloud/management-client.mjs';

const operationId = 'aaaa1111-2222-4333-8444-555555555555';
const currentVersion = '0.1.5-preview.13';
const nextVersion = '0.1.5-preview.14';
const releaseSha256 = 'a'.repeat(64);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function ui(provider) {
  assert.ok(consoleScript.includes(consoleUpgradeScript), 'Run the same upgrade script that the console serves');
  const elements = new Map();
  let active;
  for (const id of ['open-upgrade', 'brand-version', 'upgrade-dialog', 'upgrade-description',
    'upgrade-status', 'confirm-upgrade', 'reconcile-upgrade', 'close-upgrade-button']) {
    elements.set(id, { hidden: true, open: false, disabled: false,
      addEventListener(type, handler) { assert.equal(type, 'click'); this.click = handler; },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      focus() { active = this; },
      showModal() { assert.equal(this.open, false); this.open = true; },
      close() { this.open = false; },
    });
  }
  const calls = [];
  const timers = new Set(), events = new Map();
  let reloads = 0, hidden = false;
  runInNewContext(consoleUpgradeScript, {
    document: { get hidden() { return hidden; }, get activeElement() { return active; },
      addEventListener(name, handler) { events.set(name, handler); }, querySelector(selector) {
      const el = elements.get(selector.slice(1));
      assert.ok(el, 'Unexpected selector ' + selector);
      return el;
    } },
    crypto: { randomUUID: () => operationId },
    URLSearchParams, AbortSignal, AbortController,
    window: { location: { reload() { reloads++; } } },
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
    async fetch(path, options) {
      const method = options.method ?? 'GET';
      const fields = Object.fromEntries(options.body ?? []);
      assert.equal(options.redirect, 'error');
      calls.push({ method, path, fields });
      const result = await provider({ method, path, fields });
      return result instanceof Response ? result : Response.json(result);
    },
  });
  await setImmediate();
  return { active: () => active, el: id => elements.get(id), posts: () => calls.filter(call => call.method === 'POST'),
    reloads: () => reloads, changeVisibility(value) { hidden = value; events.get('visibilitychange')(); },
    async advance() {
      await setImmediate();
      const [task] = timers;
      assert.ok(task, 'Expected a pending timer');
      timers.delete(task);
      await task();
    },
  };
}

test('upgrade UI after lost submission response only reconciles the same operation and reports observed traffic', async () => {
  const started = deferred();
  let phase = 'idle';
  let reconciled = 0;
  const app = await ui(async ({ path, fields }) => {
    switch (path) {
      case '/admin/upgrade/check': return { currentVersion, nextVersion, releaseSha256 };
      case '/admin/upgrade/status': return { phase, currentVersion, ...(phase === 'idle' ? {} : { operationId }) };
      case '/admin/upgrade/start':
        assert.deepEqual(fields, { version: nextVersion, releaseSha256, operationId });
        phase = 'deploying';
        await started.promise;
        throw new TypeError('Lost simulated browser response');
      case '/admin/upgrade/reconcile':
        assert.deepEqual(fields, { operationId });
        return { version: nextVersion, status: ++reconciled === 1
          ? 'baseline_active_rollout_unconfirmed' : 'deployment_confirmed' };
      default: assert.fail('Unexpected request ' + path);
    }
  });
  const open = app.el('open-upgrade');
  const dialog = app.el('upgrade-dialog');
  const confirm = app.el('confirm-upgrade');
  const reconcile = app.el('reconcile-upgrade');
  const status = app.el('upgrade-status');
  await open.click();
  assert.equal(confirm.hidden, false);
  confirm.focus();
  const submission = confirm.click();
  assert.equal(app.active(), app.el('close-upgrade-button'));
  await confirm.click();
  dialog.close();
  await open.click();
  assert.equal(confirm.hidden, true);
  started.resolve();
  await submission;
  assert.equal(reconcile.hidden, false);
  assert.match(status.textContent, /不要直接重复提交/);
  reconcile.focus();
  await reconcile.click();
  assert.equal(app.active(), reconcile);
  assert.equal(reconcile['aria-disabled'], undefined);
  assert.match(status.textContent, /流量仍全部指向旧版.*候选版本已上传.*仍未确认/);
  assert.equal(confirm.hidden, true);
  assert.equal(reconcile.hidden, false);
  await reconcile.click();
  assert.match(status.textContent, /已确认切换流量.*检查登录和设备列表/);
  assert.equal(reconcile.hidden, true);
  assert.equal(app.active(), app.el('close-upgrade-button'));
  assert.deepEqual(app.posts().map(({ path }) => path), [
    '/admin/upgrade/start', '/admin/upgrade/reconcile', '/admin/upgrade/reconcile',
  ]);
});

test('upgrade UI retains access to recovery when the signed feed is unavailable', async () => {
  const app = await ui(({ path }) => {
    if (path === '/admin/upgrade/check') throw new TypeError('Simulated unavailable feed');
    if (path === '/admin/upgrade/status') return { phase: 'deploying', currentVersion, operationId };
    assert.fail('Unexpected write ' + path);
  });
  assert.equal(app.el('open-upgrade').hidden, false);
  assert.equal(app.el('open-upgrade')['aria-label'], '查看升级状态');
  assert.equal(app.el('brand-version').textContent, 'v' + currentVersion);
  await app.el('open-upgrade').click();
  assert.equal(app.el('confirm-upgrade').hidden, true);
  assert.equal(app.el('reconcile-upgrade').hidden, false);
  assert.deepEqual(app.posts(), []);
});

test('a status response from a closed upgrade dialog cannot override the reopened dialog', async () => {
  const stale = deferred();
  let reads = 0;
  const app = await ui(({ path }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status') {
      reads++;
      if (reads === 2) return stale.promise;
      return reads === 1 ? { phase: 'idle', currentVersion } : { phase: 'deploying', operationId, currentVersion };
    }
    assert.fail('Unexpected write ' + path);
  });

  const open = app.el('open-upgrade');
  const confirm = app.el('confirm-upgrade');
  const reconcile = app.el('reconcile-upgrade');
  const status = app.el('upgrade-status');
  const first = open.click();
  app.el('upgrade-dialog').close();
  await open.click();
  assert.equal(confirm.hidden, true);
  assert.equal(reconcile.hidden, false);
  stale.resolve({ phase: 'idle', currentVersion });
  await first;
  assert.equal(confirm.hidden, true);
  assert.equal(reconcile.hidden, false);
  assert.match(status.textContent, /版本切换结果尚未确认/);
  await confirm.click();
  assert.deepEqual(app.posts(), []);
});

for (const outcome of ['unconfirmed', 'response lost']) {
  test('reopening during reconciliation retains the same operation after ' + outcome, async () => {
    const reply = deferred();
    let reconciles = 0;
    const app = await ui(async ({ path, fields }) => {
      if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
      if (path === '/admin/upgrade/status') return reconciles < 2
        ? { phase: 'deploying', operationId, currentVersion }
        : { phase: 'confirmed', version: nextVersion, operationId, currentVersion: nextVersion };
      if (path === '/admin/upgrade/reconcile') {
        assert.deepEqual(fields, { operationId });
        if (++reconciles === 1) {
          await reply.promise;
          if (outcome === 'response lost') throw new TypeError('Lost simulated reconcile response');
        }
        return { status: reconciles === 1 ? 'baseline_active_rollout_unconfirmed' : 'deployment_confirmed', version: nextVersion, operationId };
      }
      assert.fail('Unexpected request ' + path);
    });

    const open = app.el('open-upgrade');
    const dialog = app.el('upgrade-dialog');
    const reconcile = app.el('reconcile-upgrade');
    const confirm = app.el('confirm-upgrade');
    const status = app.el('upgrade-status');
    await open.click();
    const inFlight = reconcile.click();
    dialog.close();
    await open.click();
    assert.equal(confirm.hidden, true);
    await reconcile.click();
    assert.equal(app.posts().length, 1);
    reply.resolve();
    await inFlight;
    assert.match(status.textContent, outcome === 'unconfirmed' ? /仍未确认/ : /未能确认操作结果/);
    assert.equal(reconcile.hidden, false);
    assert.equal(reconcile.disabled, false);
    await reconcile.click();
    assert.match(status.textContent, /新版本已上线/);
    assert.equal(app.reloads(), 1);
    assert.equal(reconcile.hidden, true);
    assert.deepEqual(app.posts().map(({ path }) => path), ['/admin/upgrade/reconcile', '/admin/upgrade/reconcile']);
  });
}

test('an upgrade confirmed after a lost response does not offer the stale target on reopen', async () => {
  let committed = false;
  const app = await ui(({ path, fields }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status') return committed
      ? { phase: 'confirmed', version: nextVersion, currentVersion: nextVersion, operationId }
      : { phase: 'idle', currentVersion };
    if (path === '/admin/upgrade/start') {
      assert.deepEqual(fields, { version: nextVersion, releaseSha256, operationId });
      committed = true;
      throw new TypeError('Fixture drops the response after the journal was confirmed');
    }
    assert.fail('Unexpected request ' + path);
  });
  const open = app.el('open-upgrade'), dialog = app.el('upgrade-dialog');
  const confirm = app.el('confirm-upgrade'), status = app.el('upgrade-status');
  await open.click();
  assert.equal(confirm.hidden, false);
  await confirm.click();
  assert.match(status.textContent, /历史记录.*曾确认切换/);
  assert.match(status.textContent, /不是对当前流量/);
  dialog.close();
  await open.click();
  assert.equal(confirm.hidden, true);
  await confirm.click();
  assert.equal(app.posts().length, 1);
});

test('fresh status invalidates a cached offer if the target is already responding from another session', async () => {
  let applied = false;
  const app = await ui(({ path }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status') return applied
      ? { phase: 'confirmed', version: nextVersion, currentVersion: nextVersion, operationId }
      : { phase: 'idle', currentVersion };
    assert.fail('Unexpected request ' + path);
  });
  applied = true;
  await app.el('open-upgrade').click();
  assert.equal(app.el('confirm-upgrade').hidden, true);
  await app.el('confirm-upgrade').click();
  assert.deepEqual(app.posts(), []);
});

test('a different confirmed operation is not reported as success for a lost submission', async () => {
  let sent = false;
  const app = await ui(({ path }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status') return sent
      ? { phase: 'confirmed', version: nextVersion, currentVersion,
        operationId: 'bbbb1111-2222-4333-8444-555555555555' }
      : { phase: 'idle', currentVersion };
    if (path === '/admin/upgrade/start') {
      sent = true;
      throw new TypeError('Fixture drops a response while an unrelated record exists');
    }
    assert.fail('Unexpected request ' + path);
  });
  await app.el('open-upgrade').click();
  await app.el('confirm-upgrade').click();
  assert.match(app.el('upgrade-status').textContent, /未能确认操作结果/);
  assert.equal(app.el('confirm-upgrade').hidden, true);
  assert.equal(app.posts().length, 1);
});


test('upgrade icon appears only for a verified newer release and checks again on click', async () => {
  let release = { currentVersion };
  const lookup = ({ path }) => {
    if (path === '/admin/upgrade/status') return { phase: 'idle', currentVersion };
    if (path === '/admin/upgrade/check') return release;
    assert.fail('Checking for upgrades must not write');
  };
  const current = await ui(lookup);
  assert.equal(current.el('open-upgrade').hidden, true);
  assert.equal(current.el('brand-version').textContent, 'v' + currentVersion);
  release = { currentVersion, nextVersion, releaseSha256 };
  const app = await ui(lookup);
  const open = app.el('open-upgrade');
  assert.equal(open.hidden, false);
  assert.equal(open['aria-label'], '升级');
  await open.click();
  assert.equal(app.el('confirm-upgrade').hidden, false);
  app.el('upgrade-dialog').close();
  release = { currentVersion };
  await open.click();
  assert.match(app.el('upgrade-description').textContent, /已是当前渠道最新版本/);
  assert.equal(open.hidden, true);
  assert.equal(app.el('confirm-upgrade').hidden, true);
  assert.deepEqual(app.posts(), []);
});

test('upgrade progress follows the journal and refreshes exactly once after the intended build responds', async () => {
  const sent = deferred();
  let phase = 'idle', responding = currentVersion, readbackId = operationId;
  const app = await ui(async ({ path }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status') return { phase, currentVersion: responding, version: nextVersion, operationId: readbackId };
    if (path === '/admin/upgrade/start') {
      await sent.promise;
      return { status: 'deployment_confirmed', version: nextVersion, operationId };
    }
    assert.fail('Unexpected request ' + path);
  });
  await app.el('open-upgrade').click();
  const request = app.el('confirm-upgrade').click();
  const status = app.el('upgrade-status');
  assert.match(status.textContent, /1\/3.*校验签名/);
  assert.equal(app.el('open-upgrade')['aria-label'], '查看升级状态');
  assert.equal(app.el('open-upgrade').textContent, undefined, 'Do not replace the icon');
  phase = 'uploading';
  await app.advance();
  assert.match(status.textContent, /2\/3.*正在上传/);
  phase = 'staged';
  await app.advance();
  assert.match(status.textContent, /2\/3.*已上传/);
  phase = 'deploying';
  await app.advance();
  assert.match(status.textContent, /3\/3.*是否已切换/);
  assert.equal(app.reloads(), 0);
  phase = 'confirmed';
  sent.resolve();
  await setImmediate();
  assert.match(status.textContent, /已确认切换流量.*是否已能访问/);
  assert.equal(app.reloads(), 0, 'Old Worker is still answering');
  responding = nextVersion;
  readbackId = 'bbbb1111-2222-4333-8444-555555555555';
  await app.advance();
  await setImmediate();
  assert.equal(app.reloads(), 0, 'A different operation still must not refresh');
  readbackId = operationId;
  await app.advance();
  await request;
  assert.match(status.textContent, /新版本已上线/);
  assert.equal(app.reloads(), 1);
  assert.equal(app.posts().length, 1);
});

for (const interruption of ['closed', 'hidden', 'reopened']) {
  test('upgrade never refreshes a page after its original foreground view was ' + interruption, async () => {
    const sent = deferred();
    let committed = false;
    const app = await ui(async ({ path }) => {
      if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
      if (path === '/admin/upgrade/status') return committed
        ? { phase: 'confirmed', currentVersion: nextVersion, version: nextVersion, operationId }
        : { phase: 'idle', currentVersion };
      if (path === '/admin/upgrade/start') {
        await sent.promise;
        committed = true;
        return { status: 'deployment_confirmed', version: nextVersion, operationId };
      }
      assert.fail('Unexpected write ' + path);
    });
    await app.el('open-upgrade').click();
    const request = app.el('confirm-upgrade').click();
    if (interruption === 'hidden') {
      app.changeVisibility(true);
      app.changeVisibility(false);
    } else {
      app.el('upgrade-dialog').close();
      if (interruption === 'reopened') await app.el('open-upgrade').click();
    }
    sent.resolve();
    await request;
    assert.equal(app.reloads(), 0);
    assert.equal(app.posts().length, 1);
  });
}

test('a rejected start with no recorded operation restores the new-version offer without retrying', async () => {
  let rejected = false;
  const app = await ui(({ path }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status') return { phase: 'idle', currentVersion };
    if (path === '/admin/upgrade/start') {
      rejected = true;
      return Response.json({ error: '发布版本已经变更。' }, { status: 409 });
    }
    assert.fail('Unexpected request ' + path);
  });
  const button = app.el('open-upgrade');
  await button.click();
  await app.el('confirm-upgrade').click();
  assert.equal(rejected, true);
  assert.equal(button['data-mode'], 'upgrade');
  assert.equal(button.title, '有新版本可升级');
  assert.match(app.el('upgrade-status').textContent, /发布版本已经变更/);
  assert.equal(app.el('confirm-upgrade').hidden, true);
  assert.equal(app.el('reconcile-upgrade').hidden, true);
  assert.equal(app.reloads(), 0);
  assert.equal(app.posts().length, 1);
});

test('an unknown start with an unavailable status never claims an unfinished upgrade was recorded', async () => {
  let lost = false;
  const app = await ui(({ path }) => {
    if (path === '/admin/upgrade/check') return { currentVersion, nextVersion, releaseSha256 };
    if (path === '/admin/upgrade/status' && !lost) return { phase: 'idle', currentVersion };
    if (path === '/admin/upgrade/start') lost = true;
    throw new TypeError('Simulated unavailable network');
  });
  const button = app.el('open-upgrade');
  await button.click();
  await app.el('confirm-upgrade').click();
  assert.equal(button.hidden, false);
  assert.equal(button.title, '升级结果尚未确认，查看状态');
  assert.match(app.el('upgrade-status').textContent, /不要直接重复提交/);
  assert.equal(app.el('confirm-upgrade').hidden, true);
  assert.equal(app.el('reconcile-upgrade').hidden, true);
  assert.equal(app.reloads(), 0);
  assert.equal(app.posts().length, 1);
});
