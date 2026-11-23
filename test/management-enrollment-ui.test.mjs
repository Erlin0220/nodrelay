import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { consoleEnrollmentScript, consoleScript } from '../cloud/management-client.mjs';

test('a durable command checks its original intent even after 15 minutes and clears revoked text', async () => {
  assert.ok(consoleScript.includes(consoleEnrollmentScript));
  const elements = new Map(), events = new Map(), requests = [];
  let nextTimer, millis = 0, state = 'pending';
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: true, open: false, focus() { document.activeElement = this; },
      addEventListener(name, handler) { this[name] = handler; },
      querySelectorAll() { return []; }, querySelector: selector => element(id + ' ' + selector),
      replaceChildren() {}, append() {}, dataset: {},
    });
    return elements.get(id);
  };
  const fireTimer = () => { const timer = nextTimer; nextTimer = undefined; return timer.fn(); };
  const document = {
    hidden: false, querySelector: element,
    addEventListener(name, handler) { events.set(name, handler); },
  };
  const ctx = {
    document, performance: { now: () => millis }, URLSearchParams, AbortSignal, AbortController,
    setTimeout(fn, delay) { nextTimer = { fn, delay }; return nextTimer; },
    clearTimeout(timer) { if (timer === nextTimer) nextTimer = undefined; },
    window: { addEventListener(name, handler) { events.set(name, handler); } },
    async refreshDeviceList() {},
    async requestJson(path) {
      requests.push(path);
      if (state === 'offline') throw new Error('fixture goes offline');
      return { registration: state };
    },
  };
  runInNewContext(consoleEnrollmentScript + '\nthis.show = showDeviceCommand;', ctx);
  element('#add-dialog').open = true;
  const copy = element('#copy-device-command'), command = element('#device-command');
  const progress = element('#device-enrollment-progress');
  element('#device-command-result').hidden = true;
  element('device ID').focus();
  ctx.show({ command: 'fixture old short command', deviceId: 'demo-mac',
    platform: 'macOS', intentId: 'old-intent', durable: true });
  assert.equal(copy.disabled, true);
  assert.equal(command.hidden, true);
  assert.equal(document.activeElement, progress);
  await setImmediate();
  assert.equal(document.activeElement, progress);
  assert.equal(copy.disabled, false);
  assert.equal(command.hidden, false);
  assert.equal(requests[0], '/admin/devices/enrollment?deviceId=demo-mac&intentId=old-intent');
  millis = 901000;
  state = 'offline';
  copy.focus();
  await fireTimer();
  assert.equal(document.activeElement, progress);
  assert.equal(nextTimer.delay, 30000);
  assert.equal(copy.disabled, true);
  document.hidden = true;
  events.get('visibilitychange')();
  assert.equal(nextTimer, undefined);
  state = 'pending';
  document.hidden = false;
  events.get('visibilitychange')();
  assert.equal(copy.disabled, true);
  assert.equal(command.hidden, true);
  await setImmediate();
  assert.equal(copy.disabled, false);
  assert.equal(command.hidden, false);
  state = 'revoked';
  command.focus();
  await fireTimer();
  assert.equal(document.activeElement, progress);
  assert.equal(nextTimer, undefined);
  assert.equal(command.textContent, '');
  assert.equal(command.hidden, true);
  assert.equal(copy.disabled, true);
  assert.match(element('#device-enrollment-progress').textContent, /已撤销/);
  assert.ok(requests.every(path => path.endsWith('intentId=old-intent')));
});

test('legacy enrollment reads beyond command expiry and only confirms authoritative activation', async () => {
  const elements = new Map(), events = new Map(), timers = new Set(), reads = [];
  let millis = 0, refreshes = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: true, open: false, focus() { document.activeElement = this; },
      addEventListener(name, handler) { this[name] = handler; }, querySelectorAll() { return []; },
      querySelector: selector => element(id + ' ' + selector), replaceChildren() {}, append() {}, dataset: {},
    });
    return elements.get(id);
  };
  const document = {
    hidden: false, querySelector: element,
    addEventListener(name, handler) { events.set(name, handler); },
  };
  const step = () => {
    const timer = [...timers].find(t => t.delay !== 1000);
    assert.ok(timer);
    timers.delete(timer);
    return timer.fn();
  };
  const ctx = {
    document, window: { addEventListener(name, handler) { events.set(name, handler); } },
    performance: { now: () => millis }, URLSearchParams, AbortSignal, AbortController,
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    async refreshDeviceList() { refreshes++; },
    requestJson(path, options) {
      return new Promise(resolve => reads.push({ path, signal: options.signal, resolve }));
    },
  };
  runInNewContext(consoleEnrollmentScript + '\nthis.show = showDeviceCommand;', ctx);
  element('#add-dialog').open = true;
  const copy = element('#copy-device-command'), command = element('#device-command');
  const progress = element('#device-enrollment-progress');
  ctx.show({ command: 'fixture legacy command', deviceId: 'demo-mac',
    platform: 'macOS', durable: false, expiresAt: 120, serverTime: 60 });
  reads[0].resolve({ registration: 'pending' });
  await setImmediate();
  assert.match(progress.textContent, /等待设备接入/);
  assert.equal(copy.disabled, false);
  assert.equal(refreshes, 0);

  millis = 1200000;
  const stale = step();
  document.hidden = true;
  events.get('visibilitychange')();
  assert.equal(reads[1].signal.aborted, true);
  reads[1].resolve({ registration: 'active' });
  await stale;
  assert.doesNotMatch(progress.textContent, /已接入/);

  document.hidden = false;
  events.get('visibilitychange')();
  assert.equal(copy.disabled, true, 'An expired legacy command must not be copied');
  reads[2].resolve({ registration: 'pending' });
  await setImmediate();
  assert.match(progress.textContent, /尚未确认.*终端结果/);
  assert.equal(refreshes, 0);
  assert.ok([...timers].some(timer => timer.delay === 30000), 'Readback continues with backoff');

  events.get('online')();
  assert.equal(reads.length, 4, 'An online event triggers immediate status verification');
  reads[3].resolve({ registration: 'active' });
  await setImmediate();
  assert.match(progress.textContent, /设备已接入 Portal/);
  assert.equal(command.textContent, '');
  assert.equal(copy.disabled, true);
  assert.equal(refreshes, 1, 'Confirmation refreshes the list without waiting for dialog close');
  assert.equal(timers.size, 0);
  assert.ok(reads.every(({ path }) => path === '/admin/devices/enrollment?deviceId=demo-mac'));
});

test('a multi-system command opens on macOS and switching systems only swaps the shown text', async () => {
  const elements = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) {
      const node = {
        hidden: false, disabled: true, open: false, children: [], focus() { document.activeElement = this; },
        addEventListener(name, handler) { this[name] = handler; }, querySelectorAll() { return []; },
        querySelector: selector => element(id + ' ' + selector), dataset: {},
        replaceChildren(...kept) { this.children = kept.filter(Boolean); }, append(...items) { this.children.push(...items); },
      };
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const created = [];
  const document = {
    hidden: false, querySelector: element, addEventListener() {},
    createElement(tag) {
      const node = { tag, children: [], dataset: {}, append(...items) { this.children.push(...items); },
        addEventListener(name, handler) { this[name] = handler; } };
      created.push(node);
      return node;
    },
  };
  const ctx = {
    document, performance: { now: () => 0 }, URLSearchParams, AbortSignal, AbortController,
    setTimeout() {}, clearTimeout() {}, window: { addEventListener() {} },
    async refreshDeviceList() {},
    async requestJson(path) { requests.push(path); return { registration: 'pending' }; },
  };
  runInNewContext(consoleEnrollmentScript + '\nthis.show = showDeviceCommand;', ctx);
  element('#add-dialog').open = true;
  const command = element('#device-command'), systems = element('#device-command-systems');
  const commandText = { macos: "sh -c \"$(curl -fsSL --proto =https 'https://c/device/install/macos?v=1')\" -- 'mac' 'CODE'",
    windows: "& ([scriptblock]::Create((irm 'https://c/device/install/windows?v=1'))) 'mac' 'CODE'" };
  ctx.show({ deviceId: 'mac', intentId: 'intent-1', durable: true, system: 'macos', command: commandText.macos,
    systems: [
      { id: 'linux', label: 'Linux', command: 'linux text', instructions: '在目标设备的终端运行。' },
      { id: 'macos', label: 'macOS', command: commandText.macos, instructions: '在目标设备的终端运行。' },
      { id: 'windows', label: 'Windows', command: commandText.windows, instructions: '在目标设备的PowerShell运行。' },
    ] });
  assert.equal(command.textContent, commandText.macos);
  assert.equal(element('#device-command-target').textContent, 'mac · macOS');
  const radios = created.filter(node => node.tag === 'input');
  assert.deepEqual(radios.map(radio => [radio.value, radio.checked]), [['linux', false], ['macos', true], ['windows', false]]);
  assert.equal(systems.children.length, 4, 'legend plus one choice per system');
  const before = requests.length;
  radios[2].checked = true;
  radios[2].change();
  assert.equal(command.textContent, commandText.windows);
  assert.equal(element('#command-instructions').textContent, '在目标设备的PowerShell运行。');
  assert.equal(element('#device-command-target').textContent, 'mac · Windows');
  assert.equal(requests.length, before, 'switching systems sends nothing to the console');
});
