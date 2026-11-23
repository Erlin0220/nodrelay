import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { consoleDeviceListScript, consoleScript } from '../cloud/management-client.mjs';

test('visible device list refreshes after the dialog is gone, preserves unaffected rows and stops when settled', async () => {
  assert.ok(consoleScript.includes(consoleDeviceListScript));
  const tasks = new Map(), pageEvents = new Map(), windowEvents = new Map();
  const blank = (extra = {}) => Object.defineProperties({
    hidden: false, value: '', textContent: '', dataset: {},
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
  }, Object.getOwnPropertyDescriptors(extra));
  const row = (device, state) => blank({
    dataset: { device, state }, innerHTML: device + state,
    querySelector() { return blank({ textContent: device }); },
    replaceWith(next) { rows.splice(rows.indexOf(this), 1, next); },
    get nextElementSibling() { return rows[rows.indexOf(this) + 1] ?? null; },
  });
  const existing = row('already-active', 'active');
  const pending = row('waiting', 'pending');
  const rows = [existing, pending];
  let hidden = false, reads = 0, settled = false;
  const tbody = blank({ rows, get firstElementChild() { return rows[0] ?? null; },
    contains: () => false, insertBefore() { assert.fail('This update must not reorder any row'); } });
  const state = blank();
  const lookup = new Proxy({ tbody, '#empty': blank({ querySelector: () => blank() }), '#device-list-feedback': state },
    { get: (target, selector) => target[selector] ?? blank() });
  let timerId = 0;
  runInNewContext(consoleDeviceListScript, {
    document: {
      get hidden() { return hidden; },
      querySelector: selector => lookup[selector], querySelectorAll: () => [],
      addEventListener(name, handler) { pageEvents.set(name, handler); },
    },
    window: { addEventListener(name, handler) { windowEvents.set(name, handler); } },
    DOMParser: class {
      parseFromString() {
        return { querySelector: selector => selector === 'tbody'
          ? { rows: [row('already-active', 'active'), row('waiting', settled ? 'active' : 'pending')] }
          : selector === '#device-search' ? blank() : null };
      }
    },
    async fetch(path, options) {
      assert.equal(path, '/');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      reads++;
      return { ok: true, text: async () => '<fixture>' };
    },
    AbortController, AbortSignal,
    setTimeout(fn, delay) { tasks.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { tasks.delete(id); },
  });
  const tick = async delay => {
    assert.equal(tasks.size, 1);
    const [id, task] = [...tasks][0];
    assert.equal(task.delay, delay);
    tasks.delete(id);
    task.fn();
    await setImmediate();
  };
  await tick(15000);
  assert.equal(reads, 1);
  assert.equal(rows[0], existing);
  assert.equal(rows[1], pending);
  hidden = true;
  pageEvents.get('visibilitychange')();
  assert.equal(tasks.size, 0);
  settled = true;
  hidden = false;
  pageEvents.get('visibilitychange')();
  await tick(0);
  assert.equal(reads, 2);
  assert.equal(rows[0], existing);
  assert.equal(rows[1].dataset.state, 'active');
  assert.equal(tasks.size, 0);
  windowEvents.get('pageshow')({ persisted: true });
  assert.equal(tasks.size, 0);
  assert.equal(state.textContent, '');
});
