const consoleBeforeUpgrade = String.raw`
  const theme = document.querySelector('#theme');
  const themeMenu = document.querySelector('#theme-menu');
  const themeOptions = [...themeMenu.querySelectorAll('[data-theme-option]')];
  const themeKey = 'nodrelay-theme';
  const themeNames = { light: '浅色', dark: '深色', system: '跟随系统' };
  let themePreference = 'system';
  function applyTheme(value) {
    themePreference = Object.hasOwn(themeNames, value) ? value : 'system';
    if (themePreference === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = themePreference;
    for (const option of themeOptions) {
      option.setAttribute('aria-checked', String(option.dataset.themeOption === themePreference));
    }
    const label = '外观主题：' + themeNames[themePreference];
    theme.title = label;
    theme.setAttribute('aria-label', label);
    document.querySelector('#theme-icon').setAttribute('href', { dark: '#moon', light: '#sun', system: '#monitor' }[themePreference]);
  }
  try { applyTheme(localStorage.getItem(themeKey)); } catch { applyTheme('system'); }

  function closeTheme(restoreFocus) {
    themeMenu.hidden = true;
    theme.setAttribute('aria-expanded', 'false');
    if (restoreFocus) theme.focus();
  }
  function openTheme(option = themeOptions.find(item => item.dataset.themeOption === themePreference)) {
    themeMenu.hidden = false;
    theme.setAttribute('aria-expanded', 'true');
    option.focus();
  }
  theme.addEventListener('click', () => themeMenu.hidden ? openTheme() : closeTheme(true));
  theme.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    openTheme(event.key === 'ArrowDown' ? themeOptions[0] : themeOptions.at(-1));
  });
  themeMenu.addEventListener('keydown', event => {
    const index = themeOptions.indexOf(document.activeElement);
    const count = themeOptions.length;
    if (event.key === 'Escape') { event.preventDefault(); closeTheme(true); return; }
    const next = { ArrowDown: (index + 1) % count, ArrowUp: (index - 1 + count) % count, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    themeOptions[next].focus();
  });
  themeMenu.addEventListener('focusout', event => {
    if (!themeMenu.contains(event.relatedTarget) && event.relatedTarget !== theme) closeTheme(false);
  });
  document.addEventListener('click', event => {
    if (!themeMenu.hidden && !theme.parentElement.contains(event.target)) closeTheme(false);
  });
  for (const option of themeOptions) {
    option.addEventListener('click', () => {
      applyTheme(option.dataset.themeOption);
      try { localStorage.setItem(themeKey, themePreference); } catch {}
      closeTheme(true);
    });
  }

`;

export const consoleDeviceListScript = String.raw`
  const search = document.querySelector('#device-search');
  const filters = [...document.querySelectorAll('[data-filter]')];
  const tbody = document.querySelector('tbody');
  const listFeedback = document.querySelector('#device-list-feedback');
  const retryList = document.querySelector('#retry-device-list');
  let listRequest;
  let listPollTimer;
  const empty = document.querySelector('#empty');
  let status = 'all';
  function updateRows() {
    const rows = [...tbody.rows];
    const query = search.value.trim().toLowerCase();
    for (const row of rows) {
      row.hidden = (status !== 'all' && row.dataset.state !== status && !(status === 'pending' && row.dataset.state === 'draft')) ||
        !row.querySelector('.device-name').textContent.toLowerCase().includes(query) && !row.dataset.device.toLowerCase().includes(query);
    }
    empty.hidden = rows.some(row => !row.hidden);
    const firstUse = rows.length === 0 && status === 'all' && query === '';
    empty.querySelector('strong').textContent = firstUse ? '还没有设备' : '未找到匹配的设备';
    empty.querySelector('p').textContent = firstUse
      ? document.querySelector('#add').disabled ? '当前没有可用的客户端安装包。' : '点击「添加设备」，开始接入第一台设备。'
      : '试试其他设备名称，或清除筛选。';
    document.querySelector('#clear-filters').hidden = firstUse;
    document.querySelector('table').hidden = !empty.hidden;
  }
  function scheduleDeviceListCheck(delay = 15000) {
    clearTimeout(listPollTimer);
    listPollTimer = undefined;
    if (document.hidden || ![...tbody.rows].some(row => row.dataset.state === 'pending')) return;
    listPollTimer = setTimeout(() => {
      if (!document.hidden && !listRequest) void refreshDeviceList({ background: true });
    }, delay);
  }
  function syncRows(rows) {
    const old = new Map([...tbody.rows].map(row => [row.dataset.device, row]));
    const next = [];
    for (const row of rows) {
      const current = old.get(row.dataset.device);
      if (current && current.innerHTML === row.innerHTML && JSON.stringify(current.dataset) === JSON.stringify(row.dataset)) {
        old.delete(row.dataset.device);
        next.push(current);
        continue;
      }
      if (current) {
        current.replaceWith(row);
        old.delete(row.dataset.device);
      }
      next.push(row);
    }
    for (const removed of old.values()) removed.remove();
    let before = tbody.firstElementChild;
    for (const row of next) {
      if (before === row) before = before.nextElementSibling;
      else tbody.insertBefore(row, before);
    }
  }
  async function refreshDeviceList({ background = false } = {}) {
    listRequest?.abort();
    const controller = new AbortController();
    listRequest = controller;
    retryList.setAttribute('aria-disabled', 'true');
    try {
      const response = await fetch('/', { cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error('List read failed');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const updated = page.querySelector('tbody');
      if (!updated || !page.querySelector('#device-search')) throw new Error('List unavailable');
      if (listRequest !== controller) return;
      const focused = document.activeElement;
      const focusRow = tbody.contains(focused) ? focused.closest('tr[data-device]') : null;
      const action = focusRow ? focused.dataset.action : undefined;
      syncRows([...updated.rows]);
      for (const filter of filters) {
        const count = page.querySelector('[data-filter="' + filter.dataset.filter + '"] .count');
        if (count) filter.querySelector('.count').textContent = count.textContent;
      }
      listFeedback.textContent = '';
      if (document.activeElement === retryList) search.focus();
      retryList.hidden = true;
      updateRows();
      if (action && document.activeElement === document.body) {
        const replacement = [...tbody.rows].find(row => !row.hidden && row.dataset.device === focusRow.dataset.device);
        const next = replacement && [...replacement.querySelectorAll('button[data-action]')].find(button => button.dataset.action === action);
        (next ?? search).focus();
      }
    } catch {
      if (listRequest === controller) {
        listFeedback.textContent = background ? '暂时无法更新设备状态，稍后自动重试。' : '刷新失败，设备列表仍是上次的结果。';
        retryList.hidden = false;
      }
    } finally {
      if (listRequest === controller) {
        listRequest = undefined;
        retryList.removeAttribute('aria-disabled');
        scheduleDeviceListCheck();
      }
    }
  }
  retryList.addEventListener('click', () => { if (!listRequest) void refreshDeviceList(); });
  document.addEventListener('visibilitychange', () => scheduleDeviceListCheck(0));
  window.addEventListener('pageshow', event => { if (event.persisted) scheduleDeviceListCheck(0); });
  window.addEventListener('online', () => scheduleDeviceListCheck(0));
  search.addEventListener('input', updateRows);
  for (const filter of filters) {
    filter.addEventListener('click', () => {
      status = filter.dataset.filter;
      for (const item of filters) item.setAttribute('aria-pressed', item === filter);
      updateRows();
    });
  }
  document.querySelector('#clear-filters').addEventListener('click', () => {
    search.value = '';
    filters[0].click();
    search.focus();
  });

  updateRows();
  scheduleDeviceListCheck();
`;

const consoleAddressScript = String.raw`
  const copy = document.querySelector('#copy-address');
  const address = document.querySelector('#address');
  const copyFeedback = document.querySelector('#copy-feedback');

  async function copyNodeContents(node) {
    try {
      await navigator.clipboard.writeText(node.textContent);
      return true;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(node);
      node.focus();
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return false;
    }
  }

  copy.addEventListener('click', async () => {
    const copied = await copyNodeContents(address);
    const result = copied ? '已复制' : '按快捷键复制';
    copy.querySelector('span').textContent = result;
    copyFeedback.textContent = copied ? 'Portal 地址已复制' : '已选中 Portal 地址，可用系统复制快捷键。';
  });


  copy.disabled = !address.textContent.startsWith('https://');
`;

export const consoleUpgradeScript = String.raw`
  async function requestJson(path, options = {}) {
    const signal = options.signal ?? AbortSignal.timeout(options.method === 'POST' ? 45000 : 12000);
    let response, data;
    try {
      response = await fetch(path, {
        ...options, signal,
        headers: { Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
      });
      data = await response.json().catch(() => null);
      signal.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (options.method === 'POST') throw new Error('未能确认操作结果。请先刷新并核对状态，不要直接重复提交。');
      throw new Error('暂时无法读取，请检查连接后再试。');
    }
    if (!response.ok || !data) throw new Error(data?.error || '请求失败，请检查管理台连接后重试。');
    return data;
  }

  function post(path, fields) {
    return requestJson(path, { method: 'POST', body: new URLSearchParams(fields) });
  }

  const upgrade = document.querySelector('#open-upgrade');
  const versionBadge = document.querySelector('#brand-version');
  const upgradeDialog = document.querySelector('#upgrade-dialog');
  const upgradeDescription = document.querySelector('#upgrade-description');
  const upgradeStatus = document.querySelector('#upgrade-status');
  const confirmUpgrade = document.querySelector('#confirm-upgrade');
  const reconcileUpgrade = document.querySelector('#reconcile-upgrade');
  const closeUpgrade = document.querySelector('#close-upgrade-button');
  function hideUpgradeAction(action) {
    if (upgradeDialog.open && document.activeElement === action) closeUpgrade.focus();
    action.hidden = true;
  }
  let pendingUpgrade;
  let releaseCheck;
  let upgradeStatusRequest;
  let upgrading;
  let upgradeView;
  const activePhases = new Set(['uploading', 'staged', 'deploying']);
  const phaseText = { uploading: '上传结果尚未确认。', staged: '已记录候选版本，切换结果尚未确认。',
    deploying: '版本切换结果尚未确认。' };
  const runningPhaseText = {
    uploading: '2/3 · 签名已校验，正在上传新版本。',
    staged: '2/3 · 新版本已上传，准备切换流量。',
    deploying: '3/3 · 正在确认 Cloudflare 是否已切换流量。',
  };
  function historicalUpgradeText(version, currentVersion) {
    const respondingVersion = currentVersion ? '当前页面版本 v' + currentVersion + '。' : '';
    return respondingVersion + '历史记录：Cloudflare 曾确认切换至 v' + version + '。这不是对当前流量或应用状态的核对。';
  }
  function cutoverText(result) {
    return result.status === 'previously_confirmed' ? historicalUpgradeText(result.version)
      : 'Cloudflare 已确认切换流量。请刷新页面，检查登录和设备列表。';
  }
  function markUpgradeRecovery(recorded = false) {
    upgrade.hidden = false;
    upgrade.setAttribute('data-mode', 'recovery');
    upgrade.setAttribute('aria-label', '查看升级状态');
    upgrade.setAttribute('title', recorded ? '有未完成的升级，查看状态' : '升级结果尚未确认，查看状态');
  }
  function showUpgradeDialog() {
    upgradeView = { foreground: !document.hidden };
    upgradeDialog.showModal();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && upgradeView) upgradeView.foreground = false;
  });
  function currentUpgradeView(view) {
    return upgradeView === view && view.foreground && upgradeDialog.open && !document.hidden;
  }
  function monitorUpgradeProgress(operationId, version, view) {
    const controller = new AbortController();
    let timer;
    const read = async () => {
      if (controller.signal.aborted || !currentUpgradeView(view)) return;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]);
      const status = await requestJson('/admin/upgrade/status', { signal }).catch(() => null);
      if (controller.signal.aborted || !currentUpgradeView(view)) return;
      if (status?.operationId === operationId && status.version === version && Object.hasOwn(runningPhaseText, status.phase)) {
        markUpgradeRecovery(true);
        const message = runningPhaseText[status.phase];
        if (upgradeStatus.textContent !== message) upgradeStatus.textContent = message;
      }
      timer = setTimeout(read, 2500);
    };
    timer = setTimeout(read, 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }
  async function reloadConfirmedUpgrade(result, operationId, version, view) {
    if (result.status !== 'deployment_confirmed' || result.operationId !== operationId ||
        result.version !== version || !currentUpgradeView(view)) return;
    upgradeStatus.textContent = 'Cloudflare 已确认切换流量。正在检查新版本是否已能访问…';
    for (let i = 0; i < 4; i++) {
      if (!currentUpgradeView(view)) return;
      const state = await requestJson('/admin/upgrade/status', { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!currentUpgradeView(view)) return;
      if (state?.phase === 'confirmed' && state.operationId === operationId &&
          state.version === version && state.currentVersion === version) {
        upgradeStatus.textContent = '新版本已上线，正在刷新管理台…';
        window.location.reload();
        return;
      }
      if (i < 3) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (currentUpgradeView(view)) upgradeStatus.textContent = cutoverText(result);
  }
  function showUpgradeHeader(feed, status) {
    const version = status?.currentVersion ?? feed?.currentVersion;
    if (version) {
      versionBadge.hidden = false;
      versionBadge.textContent = 'v' + version;
    }
    // Recovery is not a new-version offer, even if a newer release also exists.
    const recovery = activePhases.has(status?.phase);
    const available = Boolean(feed?.nextVersion && feed.nextVersion !== version);
    upgrade.setAttribute('data-mode', recovery ? 'recovery' : 'upgrade');
    upgrade.setAttribute('aria-label', recovery ? '查看升级状态' : '升级');
    upgrade.setAttribute('title', recovery ? '有未完成的升级，查看状态' : '有新版本可升级');
    upgrade.hidden = !recovery && !available;
  }
  async function readUpgradeHeader() {
    const [feed, status] = await Promise.all([
      requestJson('/admin/upgrade/check').catch(() => null),
      requestJson('/admin/upgrade/status').catch(() => null),
    ]);
    if (!upgrading) showUpgradeHeader(feed, status);
  }
  void readUpgradeHeader();
  upgrade.addEventListener('click', async () => {
    if (upgradeDialog.open) return;
    upgradeStatusRequest?.abort();
    const controller = new AbortController();
    upgradeStatusRequest = controller;
    const isCurrent = () => upgradeDialog.open && upgradeStatusRequest === controller;
    upgradeDescription.textContent = '正在检查签名升级包。';
    upgradeStatus.textContent = '正在读取升级记录…';
    confirmUpgrade.hidden = true;
    if (upgrading) {
      // Let the in-flight POST finish and render its result. An overlapping
      // GET could overwrite that result or lose the retry button.
      const checking = upgrading === 'reconcile';
      reconcileUpgrade.hidden = !checking;
      upgradeStatus.textContent = checking ? '正在向 Cloudflare 核对实际生效的版本…'
        : '正在等待 Cloudflare 响应，请勿重复提交。';
      showUpgradeDialog();
      return;
    }
    reconcileUpgrade.hidden = true;
    pendingUpgrade = undefined;
    showUpgradeDialog();
    try {
      const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) };
      const [status, fresh] = await Promise.all([
        requestJson('/admin/upgrade/status', options),
        requestJson('/admin/upgrade/check', options).catch(() => null),
      ]);
      if (!isCurrent()) return;
      const { phase, operationId, version, currentVersion } = status;
      showUpgradeHeader(fresh, status);
      releaseCheck = fresh;
      const target = fresh?.nextVersion;
      upgradeDescription.textContent = target
        ? 'v' + fresh.currentVersion + ' → v' + target + '。域名、登录、数据库和已连接设备不变。' +
          (fresh.includesEnrollment ? ' 本次会更新新设备的接入方式，旧命令仍按原版本运行。' : '')
        : fresh?.available === false ? '此管理台尚未配置在线升级。'
          : fresh?.currentVersion ? 'v' + fresh.currentVersion + ' 已是当前渠道最新版本。'
            : '暂时无法核验是否有新版本。';
      if (activePhases.has(phase)) {
        if (operationId && !upgrading) {
          pendingUpgrade = operationId;
          reconcileUpgrade.hidden = false;
          upgradeStatus.textContent = phaseText[phase] + ' 可以核对 Cloudflare 实际状态，不会重复提交。';
        } else upgradeStatus.textContent = '正在等待 Cloudflare 响应，请勿重复提交。';
      } else {
        upgradeStatus.textContent = upgrading ? '正在等待 Cloudflare 响应。'
          : phase === 'confirmed' ? historicalUpgradeText(version, currentVersion) : '';
        if (target && target === currentVersion) {
          releaseCheck = undefined;
          upgradeDescription.textContent = '此页面已由 v' + currentVersion + ' 响应，无需重复提交该版本。';
        }
        confirmUpgrade.hidden = !releaseCheck?.nextVersion || Boolean(upgrading);
      }
    } catch {
      if (isCurrent()) upgradeStatus.textContent = '暂时无法读取升级记录，请稍后重新打开。';
    }
  });
  reconcileUpgrade.addEventListener('click', async () => {
    if (!upgradeDialog.open || reconcileUpgrade.hidden || !pendingUpgrade || upgrading) return;
    const view = upgradeView;
    const operationId = pendingUpgrade;
    upgrading = 'reconcile';
    reconcileUpgrade.setAttribute('aria-disabled', 'true');
    upgradeStatus.textContent = '正在向 Cloudflare 核对实际生效的版本…';
    try {
      const result = await post('/admin/upgrade/reconcile', { operationId });
      if (result.operationId && result.operationId !== operationId) throw new Error('核对结果不属于本次升级。请先查看升级记录。');
      if (result.status === 'baseline_active_upload_unconfirmed') {
        upgradeStatus.textContent = 'Cloudflare 流量仍指向旧版，上传结果无法确认。本次核对没有重新上传或切换。请保留记录，不要重新提交。';
        return;
      }
      if (result.status === 'baseline_active_candidate_staged') {
        upgradeStatus.textContent = '候选版本已核对，Cloudflare 流量仍指向旧版。本次核对没有切换。请保留记录，不要重新提交。';
        return;
      }
      if (result.status === 'baseline_active_rollout_unconfirmed') {
        upgradeStatus.textContent = '核对时 Cloudflare 流量仍全部指向旧版，候选版本已上传，但上次切换的结果仍未确认。请稍后再核对，不要重复提交。';
        return;
      }
      if (!['deployment_confirmed', 'previously_confirmed'].includes(result.status)) throw new Error('尚未确认已切换。');
      upgradeStatus.textContent = cutoverText(result);
      pendingUpgrade = undefined;
      releaseCheck = undefined;
      hideUpgradeAction(reconcileUpgrade);
      await reloadConfirmedUpgrade(result, operationId, result.version, view);
    } catch (error) { upgradeStatus.textContent = error.message; }
    finally { upgrading = undefined; reconcileUpgrade.removeAttribute('aria-disabled'); }
  });
  confirmUpgrade.addEventListener('click', async () => {
    const version = releaseCheck?.nextVersion;
    const digest = releaseCheck?.manifestSha256
      ? { manifestSha256: releaseCheck.manifestSha256 } : releaseCheck?.releaseSha256 && { releaseSha256: releaseCheck.releaseSha256 };
    if (!upgradeDialog.open || confirmUpgrade.hidden || !version || !digest || upgrading) return;
    const operationId = crypto.randomUUID();
    const view = upgradeView;
    upgrading = 'start';
    hideUpgradeAction(confirmUpgrade);
    upgradeStatus.textContent = '1/3 · 正在校验签名和目标版本。可以关闭此窗口，稍后查看结果。';
    markUpgradeRecovery();
    const stopProgress = monitorUpgradeProgress(operationId, version, view);
    try {
      const result = await post('/admin/upgrade/start', { version, ...digest, operationId });
      stopProgress();
      if (result.operationId !== operationId || result.version !== version ||
          !['deployment_confirmed', 'previously_confirmed'].includes(result.status)) {
        throw new Error('发布结果未确认。请先核对升级状态。');
      }
      upgradeStatus.textContent = cutoverText(result);
      releaseCheck = undefined;
      await reloadConfirmedUpgrade(result, operationId, version, view);
    } catch (error) {
      stopProgress();
      upgradeStatus.textContent = error.message;
      const state = await requestJson('/admin/upgrade/status').catch(() => null);
      if (activePhases.has(state?.phase) && state.operationId) markUpgradeRecovery(true);
      else if (state?.phase === 'idle') showUpgradeHeader(releaseCheck, state);
      else markUpgradeRecovery();
      if (state?.phase === 'confirmed' && state.operationId === operationId && state.version === version) {
        releaseCheck = undefined;
        showUpgradeHeader(null, state);
        if (upgradeDialog.open) {
          upgradeDescription.textContent = '已找到本次升级记录，无需重复提交。';
          upgradeStatus.textContent = historicalUpgradeText(state.version, state.currentVersion);
        }
      } else if (upgradeDialog.open && activePhases.has(state?.phase) && state.operationId) {
        pendingUpgrade = state.operationId;
        reconcileUpgrade.hidden = false;
      }
    } finally { upgrading = undefined; }
  });
`;

const consoleAfterUpgrade = String.raw`
  const callbackPath = '/admin/client-callbacks';
  const callbackDialog = document.querySelector('#callback-dialog');
  const callbackTitle = document.querySelector('#callback-title');
  const callbackOverview = document.querySelector('#callback-overview');
  const callbackStatus = document.querySelector('#callback-state');
  const callbackSummary = document.querySelector('#callback-summary');
  const callbackFeedback = document.querySelector('#callback-feedback');
  const callbackList = document.querySelector('#callback-configured-list');
  const callbackForm = document.querySelector('#callback-form');
  const callbackName = document.querySelector('#callback-name');
  const callbackAddress = document.querySelector('#callback-url');
  const callbackSaveError = document.querySelector('#callback-save-error');
  const callbackClose = callbackDialog.querySelector('.dialog-close');
  const saveCallback = document.querySelector('#save-callback');
  const cancelCallback = document.querySelector('#cancel-callback');
  const addClient = document.querySelector('#add-client');
  const addWorkBuddy = document.querySelector('#add-workbuddy');
  const presetRows = callbackDialog.querySelectorAll('[data-preset-name]');
  let callbackFormTrigger;
  let allowedCallbacks = new Set();
  let callbackSubmitting = false;
  let callbackLoad;

  function callbackText(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }

  function callbackError(input, message) {
    callbackText(document.getElementById(input.id + '-error'), message);
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function resetCallbackForm() {
    callbackTitle.textContent = '客户端回调配置';
    callbackForm.reset();
    callbackError(callbackName, '');
    callbackError(callbackAddress, '');
    callbackText(callbackSaveError, '');
    callbackForm.hidden = true;
    callbackOverview.hidden = false;
  }

  function callbackRow(uri, name, enabled) {
    const row = document.createElement('li');
    row.className = 'callback-client';
    const identity = document.createElement('div');
    identity.className = 'callback-identity';
    const label = document.createElement('strong');
    label.textContent = name;
    const tag = document.createElement('span');
    tag.className = 'callback-tag';
    tag.textContent = enabled ? '已配置' : '已保存';
    identity.append(label, tag);
    const field = document.createElement('div');
    field.className = 'callback-uri';
    const address = document.createElement('code');
    address.textContent = uri;
    field.append(address);
    row.append(identity, field);
    return row;
  }

  function renderCallbacks(state) {
    const { allowedUris = [], clients = [], presets = [] } = state;
    const enabled = state.enabled === true;
    allowedCallbacks = new Set(allowedUris);
    const labels = new Map(presets.flatMap(({ client, uris }) => uris.map(uri => [uri, client])));
    for (const { redirectUri, clientName } of clients) labels.set(redirectUri, clientName);
    callbackStatus.textContent = enabled ? '已启用' : '未启用';
    callbackSummary.textContent = enabled
      ? 'Portal 已设 ' + allowedCallbacks.size + ' 条回调规则。' +
        (state.allowLocalhost ? ' 允许 localhost。' : '') + (state.allowLoopback ? ' 允许环回地址。' : '')
      : 'Portal 的动态客户端注册未启用。';
    addClient.disabled = addWorkBuddy.disabled = !enabled;
    callbackList.replaceChildren(...[...allowedCallbacks].map(uri =>
      callbackRow(uri, labels.get(uri) || URL.parse(uri)?.hostname || '现有回调', enabled)));
    document.querySelector('#callback-configured').hidden = !allowedCallbacks.size;
    for (const row of presetRows) {
      for (const address of row.querySelectorAll('[data-callback-address]')) {
        const uri = address.dataset.callbackAddress || address.textContent;
        const configured = allowedCallbacks.has(uri);
        const status = address.parentElement.querySelector('span');
        status.dataset.label ??= status.textContent;
        status.textContent = status.dataset.label + ' · ' +
          (configured ? (enabled ? '已配置' : '已保存') : '未配置');
      }
    }
    const workBuddyStatus = document.querySelector('#workbuddy-state');
    const configured = clients.some(({ clientName }) => clientName.toLowerCase() === 'workbuddy');
    workBuddyStatus.textContent = configured ? (enabled ? '已配置' : '已保存') : '待配置';
    workBuddyStatus.dataset.tone = configured ? '' : 'pending';
  }

  const retryCallbacks = document.querySelector('#retry-callback-read');
  async function loadCallbacks() {
    retryCallbacks.hidden = true;
    resetCallbackForm();
    callbackText(callbackFeedback, '');
    addClient.disabled = addWorkBuddy.disabled = true;
    document.querySelector('#callback-configured').hidden = true;
    document.querySelector('#callback-presets').hidden = true;
    callbackStatus.textContent = '读取中';
    callbackSummary.textContent = '正在读取 Portal 中的配置…';
    const loading = requestJson(callbackPath);
    callbackLoad = loading;
    try {
      const state = await loading;
      if (callbackLoad !== loading || !callbackDialog.open) return;
      renderCallbacks(state);
      document.querySelector('#callback-presets').hidden = false;
    } catch (error) {
      if (callbackLoad !== loading || !callbackDialog.open) return;
      callbackStatus.textContent = '读取失败';
      callbackSummary.textContent = '暂时无法读取 Portal 配置。';
      callbackText(callbackFeedback, error.message);
      retryCallbacks.hidden = false;
    }
  }
  document.querySelector('#open-callbacks').addEventListener('click', () => {
    callbackDialog.showModal();
    void loadCallbacks();
  });
  retryCallbacks.addEventListener('click', loadCallbacks);

  for (const trigger of [addClient, addWorkBuddy]) {
    trigger.addEventListener('click', () => {
      callbackFormTrigger = trigger;
      callbackText(callbackFeedback, '');
      callbackOverview.hidden = true;
      callbackForm.hidden = false;
      const client = trigger.dataset.client;
      callbackTitle.textContent = client ? '填写 WorkBuddy 回调' : '添加其他客户端';
      callbackName.value = client || '';
      (client ? callbackAddress : callbackName).focus();
    });
  }

  function cancelCallbackForm() {
    resetCallbackForm();
    callbackFormTrigger.focus();
  }

  cancelCallback.addEventListener('click', cancelCallbackForm);
  callbackDialog.addEventListener('cancel', event => {
    if (callbackForm.hidden) return;
    event.preventDefault();
    if (!callbackSubmitting) cancelCallbackForm();
  });
  for (const input of [callbackName, callbackAddress]) {
    input.addEventListener('input', () => {
      callbackError(input, '');
      callbackText(callbackSaveError, '');
    });
  }
  callbackForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (callbackSubmitting) return;
    const clientName = callbackName.value.trim();
    const redirectUri = callbackAddress.value.trim();
    const nameError = clientName ? '' : '请填写客户端名称。';
    const uriError = !redirectUri ? '请填写回调地址。'
      : allowedCallbacks.has(redirectUri) ? '该回调地址已配置。' : '';
    callbackError(callbackName, nameError);
    callbackError(callbackAddress, uriError);
    if (nameError || uriError) {
      (nameError ? callbackName : callbackAddress).focus();
      return;
    }
    callbackSubmitting = true;
    saveCallback.disabled = cancelCallback.disabled = callbackClose.disabled = true;
    saveCallback.textContent = '正在保存…';
    callbackText(callbackSaveError, '');
    try {
      renderCallbacks(await post(callbackPath, { clientName, redirectUri }));
      resetCallbackForm();
      callbackText(callbackFeedback, '回调地址已保存到 Portal。');
      callbackFeedback.focus();
    } catch (error) {
      callbackText(callbackSaveError, error.message);
    } finally {
      callbackSubmitting = false;
      saveCallback.disabled = cancelCallback.disabled = callbackClose.disabled = false;
      saveCallback.textContent = '保存';
    }
  });

`;

export const consoleEnrollmentScript = String.raw`
  const addDialog = document.querySelector('#add-dialog');
  const addTitle = document.querySelector('#add-title');
  const addForm = document.querySelector('#add-device-form');
  const addFeedback = document.querySelector('#add-feedback');
  const saveDevice = document.querySelector('#save-device');
  const setupForm = document.querySelector('#setup-device-form');
  const setupFeedback = document.querySelector('#setup-feedback');
  const issue = document.querySelector('#issue-command');
  const browserConsent = document.querySelector('#browser-consent');
  const browserConsentOption = document.querySelector('#confirm-browser');
  const addClose = [...addDialog.querySelectorAll('[form="close-add"]')];
  const commandResult = document.querySelector('#device-command-result');
  const command = document.querySelector('#device-command');
  const copyCommand = document.querySelector('#copy-device-command');
  const commandFeedback = document.querySelector('#device-command-feedback');
  const commandSystems = document.querySelector('#device-command-systems');
  const platformChoices = setupForm.querySelector('.platform-tabs');
  // One durable command per device covers every hosted system: choosing a
  // system only swaps the displayed text, so opening shows a command at once.
  const anySystem = addDialog.dataset.anySystem === 'true';
  const anySystemConsent = addDialog.dataset.browserConsent === 'true';
  const issueLabel = issue.textContent;
  const setupHint = document.querySelector('#setup-device-hint');
  const setupHintText = setupHint.textContent;
  let issuing = false;
  let issued = false;
  let enrollment;
  let expiryTimer;
  let pollTimer;
  let pendingPoll;
  let addOriginDeviceId;
  const expiryLabel = document.querySelector('#device-command-expiration');
  const enrollmentFeedback = document.querySelector('#device-enrollment-progress');
  const reportEnrollment = text => {
    if (enrollmentFeedback.textContent !== text) enrollmentFeedback.textContent = text;
  };

  function hideCommand(hideText = true) {
    if (addDialog.open && (document.activeElement === copyCommand || (hideText && document.activeElement === command))) {
      enrollmentFeedback.focus();
    }
    copyCommand.disabled = true;
    command.hidden = hideText;
    if (hideText) commandSystems.hidden = true;
  }

  function showCommandPanel() {
    commandResult.hidden = false;
    enrollmentFeedback.focus();
    addForm.hidden = true;
    setupForm.hidden = true;
  }

  function renderExpiry() {
    if (!enrollment || !addDialog.open || document.hidden) return;
    if (enrollment.durable) {
      expiryLabel.textContent = enrollment.claimed || enrollment.done ? '' : '未领取的命令不会过期，可从设备行撤销。';
      if (!enrollment.verified || enrollment.claimed || enrollment.done || !command.textContent) hideCommand();
      else {
        copyCommand.disabled = false;
        command.hidden = false;
        commandSystems.hidden = !commandSystems.querySelector('input');
      }
      return;
    }
    const seconds = Math.max(0, Math.ceil((enrollment.expires - performance.now()) / 1000));
    expiryLabel.textContent = seconds === 0 ? '命令已过期，不能再发起安装。'
      : '命令还可使用 ' + Math.floor(seconds / 60) + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒';
    const unavailable = !seconds || enrollment.done === true;
    if (unavailable && document.activeElement === copyCommand) enrollmentFeedback.focus();
    copyCommand.disabled = unavailable;
    clearTimeout(expiryTimer);
    if (seconds && !enrollment.done) expiryTimer = setTimeout(renderExpiry, 1000);
  }

  function pauseEnrollment() {
    clearTimeout(expiryTimer);
    clearTimeout(pollTimer);
    pendingPoll?.abort();
    pendingPoll = undefined;
    if (enrollment?.durable) {
      enrollment.verified = false;
      hideCommand();
    }
  }

  async function checkEnrollment() {
    const current = enrollment;
    if (!current || current.done || !addDialog.open || document.hidden || pendingPoll) return;
    const controller = new AbortController();
    pendingPoll = controller;
    try {
      const query = new URLSearchParams({ deviceId: current.deviceId });
      if (current.durable) query.set('intentId', current.intentId);
      const data = await requestJson('/admin/devices/enrollment?' + query, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
      });
      if (pendingPoll !== controller || enrollment !== current || !addDialog.open || document.hidden) return;
      if (['active', 'disabled', 'revoked'].includes(data.registration)) {
        current.done = true;
        clearTimeout(expiryTimer);
        command.textContent = '';
        expiryLabel.textContent = '';
        commandFeedback.hidden = true;
        reportEnrollment(data.registration === 'active'
          ? '设备已接入 Portal。可在设备列表查看连接详情。'
          : data.registration === 'revoked' ? '这条安装命令已撤销。' : '这台设备的接入已停用。');
        hideCommand();
        void refreshDeviceList();
      } else if (data.registration === 'installing') {
        current.claimed = true;
        command.textContent = '';
        commandFeedback.hidden = true;
        expiryLabel.textContent = '';
        reportEnrollment('目标设备已领取命令，Portal 尚未确认接入。如果终端显示错误，请以终端提示为准。');
        hideCommand();
      } else if (data.registration === 'pending') {
        current.verified = true;
        if (current.durable) renderExpiry();
        reportEnrollment(current.started + 60000 > performance.now()
          ? '等待设备接入。Portal 确认后，状态会自动更新。'
          : 'Portal 尚未确认设备接入。如果已执行安装命令，请查看目标设备的终端结果；无需在这里重复生成命令。');
      } else {
        throw new Error('Unknown registration status');
      }
    } catch {
      if (pendingPoll !== controller || enrollment !== current || !addDialog.open || document.hidden) return;
      reportEnrollment('暂时查不到接入状态，不代表安装失败。会自动重试。');
      if (current.durable) {
        current.verified = false;
        hideCommand();
      }
    } finally {
      if (pendingPoll === controller) {
        pendingPoll = undefined;
        if (enrollment === current && !current.done && addDialog.open && !document.hidden) {
          const age = performance.now() - current.started;
          pollTimer = setTimeout(checkEnrollment, age < 60000 ? 2500 : age < 600000 ? 10000 : 30000);
        }
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    pauseEnrollment();
    if (!document.hidden && enrollment && !enrollment.done) {
      renderExpiry();
      checkEnrollment();
    }
  });
  window.addEventListener('online', () => {
    if (!document.hidden && enrollment && !enrollment.done) {
      clearTimeout(pollTimer);
      void checkEnrollment();
    }
  });
  function configureBrowserConsent() {
    const bundled = platformChoices.disabled ? anySystemConsent
      : setupForm.querySelector('input[name="platform"]:checked')?.dataset.browser === 'true';
    browserConsent.hidden = !bundled;
    browserConsentOption.disabled = !bundled;
    browserConsentOption.required = bundled;
    browserConsentOption.checked = false;
  }
  function resetAddDialog() {
    const refresh = issued;
    pauseEnrollment();
    enrollment = undefined;
    issued = false;
    addForm.reset();
    for (const option of setupForm.querySelectorAll('input[name="platform"]')) {
      if (option.dataset.lockedByDevice === 'true') {
        option.disabled = false;
        delete option.dataset.lockedByDevice;
      }
    }
    setupForm.reset();
    setupForm.hidden = true;
    setupFeedback.hidden = true;
    platformChoices.disabled = false;
    platformChoices.hidden = false;
    issue.textContent = issueLabel;
    setupHint.textContent = setupHintText;
    commandSystems.replaceChildren(commandSystems.querySelector('legend'));
    commandSystems.hidden = true;
    saveDevice.disabled = false;
    issue.disabled = false;
    configureBrowserConsent();
    addTitle.textContent = '添加设备';
    addForm.hidden = false;
    commandResult.hidden = true;
    command.textContent = '';
    copyCommand.disabled = true;
    copyCommand.querySelector('span').textContent = '复制';
    commandFeedback.hidden = true;
    commandFeedback.textContent = '';
    expiryLabel.textContent = '';
    enrollmentFeedback.textContent = '';
    addFeedback.hidden = true;
    if (refresh) void refreshDeviceList();
  }
  setupForm.addEventListener('change', event => { if (event.target.name === 'platform') configureBrowserConsent(); });
  document.querySelector('#add').addEventListener('click', () => {
    if (issuing || addDialog.open) return;
    resetAddDialog();
    addDialog.showModal();
  });
  addDialog.addEventListener('cancel', event => { if (issuing) event.preventDefault(); });
  addDialog.addEventListener('close', () => {
    if (addDialog.open) return;
    const originId = addOriginDeviceId;
    addOriginDeviceId = undefined;
    resetAddDialog();
    if (originId && document.activeElement === document.body) {
      const currentRow = [...tbody.rows].find(row => !row.hidden && row.dataset.device === originId);
      (currentRow?.querySelector('button[data-action="status"], button[data-action="setup-command"], button[data-action="intent-command"]') ?? search).focus();
    }
  });
  function showDeviceCommand(result) {
    issued = true;
    const systems = Array.isArray(result.systems) && result.systems.length ? result.systems
      : [{ id: '', label: result.platform, command: result.command, instructions: result.instructions }];
    const show = system => {
      command.textContent = system.command;
      document.querySelector('#device-command-target').textContent = result.deviceId + ' · ' + system.label;
      document.querySelector('#command-instructions').textContent = system.instructions ?? result.instructions;
      copyCommand.querySelector('span').textContent = '复制';
      commandFeedback.hidden = true;
    };
    commandSystems.replaceChildren(commandSystems.querySelector('legend'));
    if (systems.length > 1) {
      for (const system of systems) {
        const choice = document.createElement('label');
        const input = Object.assign(document.createElement('input'), {
          type: 'radio', name: 'command-system', value: system.id, className: 'sr-only', checked: system.id === result.system,
        });
        const text = document.createElement('span');
        text.textContent = system.label;
        input.addEventListener('change', () => { if (input.checked) show(system); });
        choice.append(input, text);
        commandSystems.append(choice);
      }
    }
    show(systems.find(system => system.id === result.system) ?? systems[0]);
    command.hidden = false;
    commandSystems.hidden = systems.length < 2;
    addFeedback.hidden = true;
    const expires = result.durable ? undefined
      : performance.now() + Math.max(0, result.expiresAt - result.serverTime) * 1000;
    enrollment = { deviceId: result.deviceId, intentId: result.intentId, expires, durable: result.durable === true,
      started: performance.now() };
    reportEnrollment('正在查询设备接入状态…');
    renderExpiry();
    checkEnrollment();
    addTitle.textContent = '设备连接指令';
    if (commandResult.hidden) showCommandPanel();
    if (!result.durable && !command.hidden) command.focus();
  }
  function beginEnrollmentWrite(button, feedback, message) {
    issuing = true;
    button.disabled = true;
    for (const control of addClose) control.disabled = true;
    feedback.hidden = false;
    feedback.textContent = message;
  }
  function endEnrollmentWrite(button) {
    issuing = false;
    button.disabled = false;
    for (const control of addClose) control.disabled = false;
  }
  addForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (issuing || issued) return;
    beginEnrollmentWrite(saveDevice, addFeedback, '正在添加设备…');
    try {
      const { draftSaved } = await post(addForm.action, new FormData(addForm));
      if (!draftSaved) throw new Error('无法确认设备已保存，请刷新列表核对。');
      issued = true;
      addDialog.close();
    } catch (error) {
      addFeedback.textContent = error.message;
      void refreshDeviceList();
    } finally { endEnrollmentWrite(saveDevice); }
  });
  setupForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (issuing || issued) return;
    beginEnrollmentWrite(issue, setupFeedback, '正在生成安装命令…');
    try {
      const result = await post(setupForm.action, new FormData(setupForm));
      if (!result.command) {
        issued = true;
        addDialog.close();
      } else showDeviceCommand(result);
    } catch (error) {
      setupFeedback.textContent = error.message;
      void refreshDeviceList();
    } finally { endEnrollmentWrite(issue); }
  });
  copyCommand.addEventListener('click', async () => {
    const current = enrollment;
    if (!current || copyCommand.disabled) return;
    const copied = await copyNodeContents(command);
    if (current !== enrollment || current.done || current.claimed || copyCommand.disabled || !addDialog.open) return;
    copyCommand.querySelector('span').textContent = copied ? '已复制' : '按快捷键复制';
    commandFeedback.textContent = copied ? '已复制完整指令。' : '已选中完整指令，请使用系统复制快捷键。';
    commandFeedback.hidden = false;
  });

`;

const consoleDeviceDetails = String.raw`
  const detail = document.querySelector('#device-dialog');
  const detailTitle = document.querySelector('#device-dialog-title');
  const summary = document.querySelector('#device-summary');
  const details = document.querySelector('#device-details');
  const detailFeedback = document.querySelector('#device-feedback');
  const riskMark = document.querySelector('#risk-mark');
  const detailDismiss = document.querySelector('#detail-dismiss');
  const detailConfirm = document.querySelector('#detail-confirm');
  const detailClose = [...detail.querySelectorAll('[form="close-detail"], #detail-dismiss')];
  const stateLabels = { pending: '等待设备接入', active: '已注册到 Portal', disabled: '已标记停用' };
  const tunnelLabels = { healthy: '运行正常', degraded: '连接不稳定', down: '未连接',
    inactive: '未连接', unregistered: '尚未建立', unverified: '未确认', check_failed: '无法查询' };
  const diagnosticLabels = { connection_failed: '连接失败或超时', invalid_response: '响应无法解析',
    protocol_mismatch: 'MCP 协议不匹配', catalog_mismatch: '工具目录与要求不符', http_error: '请求未通过',
    timeout: '查询超时', authorization: 'Cloudflare 授权不可用', check_failed: '检查未完成' };
  function describe(base, diagnostic) {
    if (!diagnostic) return base;
    return [base, diagnosticLabels[diagnostic.reason], diagnostic.httpStatus && 'HTTP ' + diagnostic.httpStatus,
      diagnostic.codes?.length && '错误码 ' + diagnostic.codes.join('、')].filter(Boolean).join(' · ');
  }
  const mcpLabels = { catalog_verified: '目录已验证', unavailable: '目录无法访问', unverified: '等待验证',
    not_enabled: '未启用', disabled: '已停用' };
  let selected;
  let saving = false;
  let refreshOnClose = false;

  function showField(field, value) {
    const label = document.querySelector('#' + field + '-label');
    const output = document.querySelector('#' + field + '-detail');
    if (label) label.hidden = !value;
    output.hidden = Boolean(label) && !value;
    output.textContent = value || '未查询';
  }

  tbody.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !tbody.contains(button)) return;
    const row = button.closest('tr');
    const action = button.dataset.action;
    if (action === 'setup-command') {
      if (issuing || addDialog.open || button.disabled) return;
      resetAddDialog();
      addOriginDeviceId = row.dataset.device;
      addTitle.textContent = '安装命令';
      addForm.hidden = true;
      setupForm.hidden = false;
      setupForm.querySelector('input[name="deviceId"]').value = row.dataset.device;
      document.querySelector('#setup-device-target').textContent = row.querySelector('.device-name').textContent;
      if (anySystem) {
        // No system choice up front: the dialog shows macOS first and every
        // other hosted system's command for the same code.
        platformChoices.disabled = true;
        platformChoices.hidden = true;
        configureBrowserConsent();
        addDialog.showModal();
        if (anySystemConsent) {
          issue.textContent = '显示安装命令';
          setupHint.textContent = '确认浏览器工具权限。';
          setupFeedback.hidden = false;
          setupFeedback.textContent = '此版本安装包包含浏览器工具，确认后显示安装命令。';
          browserConsentOption.focus();
        } else setupForm.requestSubmit();
        return;
      }
      const locked = row.dataset.platform;
      if (locked) {
        for (const option of setupForm.querySelectorAll('input[name="platform"]')) {
          if (option.disabled) continue;
          option.checked = option.value === locked;
          if (!option.checked) {
            option.disabled = true;
            option.dataset.lockedByDevice = 'true';
          }
        }
        configureBrowserConsent();
      }
      const platform = setupForm.querySelector('input[name="platform"]:checked:not(:disabled)');
      issue.disabled = !platform;
      if (!platform) {
        setupFeedback.hidden = false;
        setupFeedback.textContent = '当前没有适合这台设备的已验证安装包。';
      }
      addDialog.showModal();
      (platform ?? addDialog.querySelector('.dialog-close')).focus();
      return;
    }
    if (action === 'intent-command') {
      if (issuing || addDialog.open) return;
      resetAddDialog();
      addOriginDeviceId = row.dataset.device;
      addTitle.textContent = '设备连接指令';
      issuing = true;
      issue.disabled = true;
      for (const control of addClose) control.disabled = true;
      addForm.hidden = true;
      commandResult.hidden = false;
      hideCommand();
      enrollmentFeedback.textContent = '正在读取已保存设备的安装命令…';
      addDialog.showModal();
      enrollmentFeedback.focus();
      try {
        showDeviceCommand(await post('/admin/enrollment-intents', {
          deviceId: row.dataset.device, intentId: row.dataset.intent, action: 'reveal',
        }));
      } catch (error) { enrollmentFeedback.textContent = error.message; }
      finally {
        issuing = false;
        for (const control of addClose) control.disabled = false;
      }
      return;
    }
    const current = { deviceId: row.dataset.device, action, ...(row.dataset.intent && { intentId: row.dataset.intent }) };
    selected = current;
    const isRisk = ['disable', 'cancel', 'intent-revoke'].includes(action);
    detail.dataset.risk = isRisk;
    detailTitle.textContent = action === 'status' ? '设备状态' : button.textContent;
    summary.textContent = row.querySelector('.device-name').textContent + ' · ' + row.querySelector('.system').textContent;
    details.hidden = isRisk;
    riskMark.hidden = !isRisk;
    detailDismiss.textContent = isRisk ? '取消' : '关闭';
    detailConfirm.hidden = !isRisk;
    detailConfirm.disabled = false;
    detailConfirm.textContent = action === 'disable' ? '确认停用' : action === 'intent-revoke' ? '确认撤销命令' : '确认取消票据';
    showField('registration', row.querySelector('.state').textContent);
    for (const field of ['checked', 'tunnel', 'mcp', 'browser', 'servers', 'release', 'revocation', 'server']) showField(field);
    detailFeedback.textContent = {
      disable: '停用将撤销该设备的安装票据、Tunnel 凭据和 Portal 路由。',
      cancel: '取消后，这台设备未使用的安装票据将失效。',
      'intent-revoke': '撤销后，已复制但未领取的安装命令立即失效。',
    }[action] || '正在检查设备状态…';
    detail.showModal();

    if (isRisk) return;
    try {
      const data = await post('/admin/device', { deviceId: current.deviceId, action: 'status' });
      if (selected !== current) return;
      showField('registration', stateLabels[data.registration] ?? data.registration);
      if (Number.isSafeInteger(data.checkedAt)) showField('checked', new Date(data.checkedAt * 1000).toLocaleString());
      showField('tunnel', describe(tunnelLabels[data.tunnel] ?? data.tunnel, data.tunnelDiagnostic));
      const development = data.mcpProfiles?.development ?? data.mcp;
      const browser = data.mcpProfiles?.browser;
      showField('mcp', describe(mcpLabels[development] ?? development, data.mcpDiagnostics?.development));
      showField('browser', describe(mcpLabels[browser] ?? browser, data.mcpDiagnostics?.browser));
      // Local MCP servers this device offers through the Portal, besides DevSpace.
      showField('servers', Array.isArray(data.mcpServers) && data.mcpServers.length
        ? data.mcpServers.map(server => server.name + '（' + (mcpLabels[server.state] ?? server.state) + '）').join('、') : '');
      showField('release', data.release);
      showField('revocation', data.revocation && (data.revocation === 'complete' ? '已完成' : '尚未完成'));
      showField('server', data.serverIds?.join(' · '));
      detailFeedback.textContent = '';
      if (action === 'review' && data.revocation !== 'complete') {
        current.action = 'disable';
        detailConfirm.hidden = false;
        detailConfirm.textContent = '重试停用';
        detailFeedback.textContent = '重试会继续撤销该设备尚未停用的远程接入。';
      }
    } catch (error) {
      if (selected === current) detailFeedback.textContent = error.message;
    }
  });

  detail.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  detail.addEventListener('close', () => {
    selected = undefined;
    if (refreshOnClose) {
      refreshOnClose = false;
      void refreshDeviceList();
    }
  });
  detailConfirm.addEventListener('click', async () => {
    if (saving || !selected || !['disable', 'cancel', 'intent-revoke'].includes(selected.action)) return;
    saving = true;
    detailConfirm.disabled = true;
    for (const button of detailClose) button.disabled = true;
    detailFeedback.textContent = '正在提交请求…';
    try {
      const result = selected.action === 'intent-revoke'
        ? await post('/admin/enrollment-intents', { deviceId: selected.deviceId, intentId: selected.intentId, action: 'revoke' })
        : await post('/admin/device', selected);
      refreshOnClose = true;
      detailConfirm.hidden = true;
      detailDismiss.textContent = '关闭';
      detailFeedback.textContent = selected.action === 'disable' ? '远程接入已停用。'
        : result.status === 'cancelled' ? (selected.action === 'intent-revoke' ? '安装命令已撤销。' : '安装票据已取消。')
          : '没有可取消的票据。已领取的凭据不受影响。';
    } catch (error) {
      detailFeedback.textContent = error.message;
    } finally {
      saving = false;
      detailConfirm.disabled = false;
      for (const button of detailClose) button.disabled = false;
    }
  });
`;

export const consoleScript = consoleBeforeUpgrade + consoleDeviceListScript + consoleAddressScript +
  consoleUpgradeScript + consoleAfterUpgrade + consoleEnrollmentScript + consoleDeviceDetails;
