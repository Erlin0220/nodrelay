import { readBoundEnrollmentState } from './enrollment-intents.mjs';
import { activatePath, activationErrorCodes, hostedInstallers, operatingSystems } from './device-paths.mjs';
import { createDevices, DeviceError } from './devices.mjs';
import { escapeHtml as e, installCommand, shortInstallCommand } from './install-command.mjs';
import { cancelTicket } from './tickets.mjs';
import { consoleScript } from './management-client.mjs';
import { consoleLogo, consoleStyles, consoleTemplate } from './management-view.mjs';
import { PortalCallbackError } from './portal-client-callbacks.mjs';
import { createUpgradeAdmin, UpgradeAdminError } from './upgrade-admin.mjs';
import { enrollmentContext, enrollmentIsEnabled } from './enrollment-v1.mjs';
import { EnrollmentAdminError } from './enrollment-admin.mjs';

const document = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)}</title>
<link rel="stylesheet" href="/admin/fleet.css"><main><h1>${e(title)}</h1>${body}</main></html>`;
const assets = {
  '/admin/console.css': ['text/css', consoleStyles],
  '/admin/console-logo.png': ['image/png', consoleLogo],
  '/admin/devices.js': ['text/javascript', consoleScript],
  '/admin/fleet.css': ['text/css', `
:root { color-scheme: light dark; font: 16px/1.6 system-ui, sans-serif; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { width: min(52rem, calc(100% - 2.5rem)); margin: 3rem auto; }
h1 { margin: 0 0 1.5rem; font-size: clamp(1.8rem, 6vw, 2.65rem); letter-spacing: -.025em; }
h2 { margin: 0 0 .75rem; font-size: 1.2rem; }
[hidden] { display: none !important; }
.toolbar { display: flex; align-items: end; justify-content: space-between; gap: .65rem; flex-wrap: wrap; margin-bottom: .75rem; }
dialog { width: min(35rem, calc(100% - 3.5rem)); border: 1px solid GrayText; border-radius: .7rem; padding: 1.25rem; }
dialog::backdrop { background: rgb(0 0 0 / .45); }
.dialog-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .8rem; }
section { border: 1px solid color-mix(in srgb, CanvasText 21%, Canvas); border-radius: .7rem; padding: 1.15rem; margin: 1rem 0; }
form { display: flex; align-items: end; gap: .6rem; flex-wrap: wrap; }
label { display: grid; gap: .2rem; }
input, select, button, textarea { font: inherit; padding: .35rem .55rem; border-radius: .35rem; }
input, select, textarea { border: 1px solid GrayText; }
button { cursor: pointer; border: 1px solid currentColor; }
.strong { background: Highlight; color: HighlightText; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; text-align: left; }
th, td { border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); padding: .65rem .5rem; }
textarea { display: block; box-sizing: border-box; width: 100%; font-family: ui-monospace, monospace; margin-bottom: .7rem; resize: vertical; }
code { overflow-wrap: anywhere; }
dd { margin: 0 0 .65rem; }
`],
  '/admin/copy.js': ['text/javascript', `
const field = document.querySelector('#command');
const button = document.querySelector('#copy');
if (field && button && navigator.clipboard) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      document.querySelector('#copy-status').textContent = '命令已复制';
    } catch {
      field.focus();
      field.select();
      document.querySelector('#copy-status').textContent = '请手动复制已选中的命令';
    }
  });
}
`],
};
const label = {
  ...Object.fromEntries(Object.entries(operatingSystems).map(([platform, entry]) => [platform, entry.label])),
  'windows-x64': 'Windows x64',
  'macos-arm64': 'macOS Apple Silicon',
  'macos-x64': 'macOS Intel',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux ARM64',
};
const state = { draft: '待安装', pending: '等待设备接入', active: '已注册到 Portal', disabled: '已标记停用', installing: '安装中' };
const mcpState = { catalog_verified: '目录已验证', unavailable: '目录无法访问', unverified: '等待验证',
  not_enabled: '未启用', disabled: '已停用' };
const durableInstructions = '请在目标设备运行。首次领取或主动撤销后失效，请勿转发。';
const shells = { windows: 'PowerShell', macos: '终端', linux: '终端' };
// Every system's command for one durable code. The client switches between
// them locally; nothing about switching or copying reaches the server.
function durableCommand(result, intentId) {
  const systems = Object.entries(result.commands ?? { [result.platform]: result.command }).map(([id, command]) => ({
    id, label: label[id] ?? id, command, instructions: `在目标设备的${shells[id] ?? '终端'}运行。首次领取或主动撤销后失效，请勿转发。`,
  }));
  const { commands, ...rest } = result;
  return { ...rest, intentId, platform: label[result.platform], system: result.platform, systems, instructions: durableInstructions };
}
function devicePage(devices, releases, portalHostname, intents, nonce) {
  const portal = /^[a-z0-9.-]+$/.test(portalHostname ?? '') ? 'https://' + portalHostname : '';
  const hosted = hostedInstallers(releases);
  const options = Object.entries(operatingSystems).flatMap(([platform, { architectures, label: text }]) => {
    if (hosted[platform]) return [{ value: platform, text, enabled: true, browser: hosted[platform].browser }];
    const local = architectures.map(arch => platform + '-' + arch).filter(value => releases[value]?.localFile);
    return local.length ? local.map(value => ({ value, text: label[value], enabled: true, browser: releases[value].browser }))
      : [{ value: platform, text, enabled: false }];
  });
  const selected = options.findIndex(option => option.enabled);
  const platforms = options.map(({ value, text, enabled, browser }, index) => `<label${enabled ? '' : ' title="当前无可用安装包"'}><input class="sr-only" type="radio" name="platform" value="${e(value)}"${browser === true ? ' data-browser="true"' : ''}${enabled ? '' : ' disabled'}${index === selected ? ' checked' : ''}><span>${e(text)}</span></label>`).join('\n');
  const button = (action, text, quiet = false) => `<button class="button${quiet ? ' quiet' : ''}" type="button" data-action="${action}">${text}</button>`;
  const rows = devices.map(device => {
    const name = device.displayName ?? device.id;
    const initial = [...name][0]?.toUpperCase() ?? '';
    const canReissue = !intents && device.status === 'pending' && options.some(option => option.enabled && option.value === device.platform);
    return `
    <tr role="row" data-state="${e(device.status === 'installing' ? 'pending' : device.status)}" data-device="${e(device.id)}"${device.intentId ? ` data-intent="${e(device.intentId)}"` : ''}${canReissue ? ` data-platform="${e(device.platform)}"` : ''}>
      <th role="rowheader" scope="row"><div class="identity"><span class="initial" aria-hidden="true">${e(initial)}</span><div><span class="device-name">${e(name)}</span><span class="system">${e(label[device.platform] ?? (device.platform || '未选择系统'))}</span></div></div></th>
      <td role="cell"><span class="state">${e(state[device.status] ?? device.status)}</span></td>
      <td role="cell"><div class="row-actions">${device.status === 'draft' ? button('setup-command', '安装命令')
        : device.intentId && device.status === 'pending' ? button('intent-command', '安装命令') + button('intent-revoke', '撤销命令', true)
        : device.intentId ? button('disable', '停用远程接入', true)
        : (canReissue ? button('setup-command', '安装命令') : '') + button('status', '查看状态') +
          (device.status === 'pending' ? button('cancel', '取消票据', true) : '') +
          (device.status === 'disabled' ? button('review', '复核停用', true) : button('disable', '停用远程接入', true))}</div></td>
    </tr>`;
  }).join('');
  const total = status => devices.filter(device => device.status === status).length;
  const values = {
    NONCE: nonce,
    SCRIPT: consoleScript,
    // Enrollment-intent consoles issue one command for every hosted system.
    ANY_SYSTEM: intents ? 'true' : 'false',
    BROWSER_CONSENT: Object.values(hosted).some(group => group.browser === true) ? 'true' : 'false',
    PORTAL: portal ? e(portal) + '<wbr>/mcp' : '尚未配置',
    ROWS: rows,
    PLATFORMS: platforms,
    ADD_DISABLED: '',
    COUNT_ALL: devices.length,
    COUNT_ACTIVE: total('active'),
    COUNT_PENDING: total('draft') + total('pending') + total('installing'),
    COUNT_DISABLED: total('disabled'),
  };
  return consoleTemplate.replace(/@@([A-Z_]+)@@/g, (_, name) => values[name]);
}
const back = '<p><a href="/">返回设备列表</a></p>';

export async function manage(request, env, url, { limitedBody, html, json, assetResponse, provider = createDevices, upgradeProvider = createUpgradeAdmin, execution }) {
  const devices = provider(env);
  const getIntents = () => enrollmentContext(env);
  const wantsJson = request.headers.get('Accept')?.split(',').some(value => value.split(';', 1)[0].trim() === 'application/json');
  try {
    if (request.method === 'GET') {
      if (Object.hasOwn(assets, url.pathname)) return assetResponse(...assets[url.pathname]);
      if (url.pathname === '/admin/client-callbacks') return json(await devices.clientCallbacks());
      if (url.pathname === '/admin/upgrade/check') return json(await upgradeProvider(env).check());
      if (url.pathname === '/admin/upgrade/status') return json(await upgradeProvider(env).status());
      if (url.pathname === '/admin/devices/enrollment') {
        const id = url.searchParams.get('deviceId');
        const intentId = url.searchParams.get('intentId');
        if (intentId !== null) {
          if (url.searchParams.getAll('intentId').length !== 1 || url.searchParams.getAll('deviceId').length !== 1) {
            return json({ error: 'Invalid enrollment query' }, 400);
          }
          const state = enrollmentIsEnabled(env) ? await readBoundEnrollmentState(env.TICKETS, id, intentId) : undefined;
          if (state === 'pending' || state === 'revoked') return json({ registration: state });
          if (state !== 'claimed') return json({ error: 'Device command unavailable' }, 404);
          let registered;
          try { registered = (await devices.enrollmentStatus(id)).registration; }
          catch (error) { if (error.status !== 404) throw error; }
          return json({ registration: ['active', 'disabled'].includes(registered) ? registered : 'installing' });
        }
        let status;
        try { status = await devices.enrollmentStatus(id); }
        catch (error) { if (error.status !== 404 || !enrollmentIsEnabled(env)) throw error; }
        if (enrollmentIsEnabled(env) && (!status || ['draft', 'pending'].includes(status.registration))) {
          status = await getIntents().registration(id) ?? status;
        }
        return status ? json(status) : json({ error: 'Device unavailable' }, 404);
      }
      if (url.pathname === '/') {
        const intents = getIntents();
        const existing = new Map((await devices.list()).map(row => [row.id, row]));
        if (intents) {
          for (const pending of await intents.list()) {
            const established = existing.get(pending.id);
            if (!established || established.status === 'draft' || established.status === 'pending' && pending.status === 'installing') {
              existing.set(pending.id, { ...established, ...pending });
            }
          }
        }
        const rows = [...existing.values()].sort((left, right) => (left.displayName ?? left.id).localeCompare(right.displayName ?? right.id) || left.id.localeCompare(right.id));
        const nonce = crypto.randomUUID();
        return html(devicePage(rows, intents?.releases ?? devices.releases, JSON.parse(env.FLEET_SPEC).portalHostname, Boolean(intents), nonce), 200, nonce);
      }
    }

    if (request.method !== 'POST') return json({ error: 'Unknown route' }, 404);
    if (url.pathname === activatePath) {
      if (request.headers.get('Content-Type')?.split(';', 1)[0] !== 'application/json') return json({ error: 'Expected JSON' }, 415);
      let input;
      try { input = JSON.parse(await limitedBody(request)); }
      catch { return json({ error: 'Invalid request' }, 400); }
      const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
      const result = await devices.activate(input?.deviceId, token, input?.servers);
      return json(result, result.status === 'revoked' ? 410 : 200);
    }
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
    if (request.headers.get('Content-Type')?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') return json({ error: 'Expected form' }, 415);
    const fields = [...new URLSearchParams(await limitedBody(request))];
    const input = Object.fromEntries(fields);
    if (url.pathname === '/admin/devices/reserve') {
      if (fields.length !== 1 || !(Object.hasOwn(input, 'name') || Object.hasOwn(input, 'deviceId'))) {
        const error = '添加设备只需要一个设备名称。';
        return wantsJson ? json({ error }, 400) : html(document('设备操作失败', `<p>${e(error)}</p>${back}`), 400);
      }
      const reserved = Object.hasOwn(input, 'name') ? await devices.reserveNamed(input.name) : await devices.reserve(input.deviceId);
      return wantsJson ? json(reserved) : html(document('设备已添加', back));
    }
    if (url.pathname.startsWith('/admin/upgrade/') && fields.length !== Object.keys(input).length) {
      return json({ error: '升级请求包含重复字段，请重新检查版本。' }, 400);
    }
    if (fields.length !== Object.keys(input).length && (url.pathname === '/admin/enrollment-intents' ||
        (url.pathname === '/admin/devices' && enrollmentIsEnabled(env)))) {
      const error = '接入请求包含重复字段，请返回设备列表后重试。';
      return wantsJson ? json({ error, code: 'duplicate_fields' }, 400)
        : html(document('设备操作失败', `<p>${e(error)}</p>${back}`), 400);
    }
    if (url.pathname === '/admin/upgrade/reconcile') return json(await upgradeProvider(env).reconcile(input));
    if (url.pathname === '/admin/upgrade/start') {
      const operation = upgradeProvider(env).start(input);
      execution?.waitUntil(operation.catch(() => {}));
      return json(await operation);
    }
    if (url.pathname === '/admin/client-callbacks') {
      return json(await devices.registerClientCallback(input.clientName, input.redirectUri));
    }
    if (url.pathname === '/admin/enrollment-intents') {
      const intents = getIntents();
      if (!intents) return json({ error: '接入命令服务暂不可用。' }, 404);
      const target = { deviceId: input.deviceId, intentId: input.intentId };
      if (input.action === 'reveal') {
        const result = await intents.command(url.origin, target);
        return json(durableCommand(result, target.intentId));
      }
      if (input.action === 'revoke') {
        await intents.admin.revoke(target);
        return json({ status: 'cancelled' });
      }
      return json({ error: '未知的接入命令操作。' }, 400);
    }
    if (url.pathname === '/admin/devices') {
      if (enrollmentIsEnabled(env)) {
        const intents = getIntents();
        const anySystem = input.platform === undefined || input.platform === '';
        const intent = await intents.admin.create({ deviceId: input.deviceId, ...(!anySystem && { platform: input.platform }),
          confirmBrowser: input.browserConsent === '1' });
        if (wantsJson && intent.preparedDraft) {
          const result = await intents.command(url.origin, { deviceId: intent.deviceId, intentId: intent.id });
          return json(durableCommand(result, intent.id));
        }
        if (wantsJson) return json({ intentSaved: true, deviceId: intent.deviceId });
        return html(document('设备已添加', back));
      }
      const { asset, ticket, expiresAt } = await devices.launch(input.deviceId, input.platform, { confirmBrowser: input.browserConsent === '1' });
      const command = asset.assets ? shortInstallCommand(url.origin, input.platform, asset.version, ticket, input.deviceId)
        : installCommand(url.origin, input.platform, asset, ticket, input.deviceId);
      const shell = input.platform === 'windows' || input.platform.startsWith('windows-') ? ' PowerShell' : '终端';
      const instructions = `${asset.localFile ? '请在预置安装包所在目录运行命令。' : ''}${asset.browser ? '请先在目标设备配置浏览器专用后端。' : ''}在目标设备的${shell}运行这条命令。票据有效期十分钟，仅可使用一次，请勿转发。`;
      if (wantsJson) return json({ command, instructions, expiresAt, serverTime: Math.floor(Date.now() / 1000), deviceId: input.deviceId, platform: label[input.platform] });
      return html(document('连接命令', `${asset.localFile ? `<p>本次试点使用目标设备上已准备的安装包 <code>${e(asset.localFile)}</code>。请在安装包所在目录运行命令。</p>` : ''}
        <p id="install-instructions">${e(instructions)}获准的管理员可调用此设备开放的文件和命令工具。</p>
        <p>${e(label[input.platform])} · <strong>${e(input.deviceId)}</strong> · 版本 ${e(asset.version)} · ${e(new Date(expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 16))} UTC 到期</p>
        <textarea id="command" rows="${asset.assets ? 3 : 8}" readonly aria-label="设备连接命令">${e(command)}</textarea>
        <button class="strong" type="button" id="copy" hidden>复制命令</button> <span role="status" id="copy-status"></span>
        <script src="/admin/copy.js" defer></script>${back}`));
    }
    if (url.pathname === '/admin/device') {
      if (input.action === 'status') {
        const result = await devices.status(input.deviceId);
        if (wantsJson) return json(result);
        const development = result.mcpProfiles?.development ?? result.mcp;
        const browser = result.mcpProfiles?.browser;
        return html(document('设备状态', `<p><strong>${e(result.deviceId)}</strong></p><dl>
          <dt>最后检查（UTC）</dt><dd>${e(new Date(result.checkedAt * 1000).toISOString())}</dd>
          <dt>注册</dt><dd>${e(state[result.registration] ?? result.registration)}</dd>
          <dt>Cloudflare Tunnel</dt><dd>${e(result.tunnel === 'check_failed' ? '无法查询' + (result.tunnelDiagnostic?.httpStatus ? ' · HTTP ' + result.tunnelDiagnostic.httpStatus : '') : result.tunnel)}</dd>
          <dt>开发工具目录</dt><dd>${e(mcpState[development] ?? development)}</dd>
          ${browser ? `<dt>浏览器工具目录</dt><dd>${e(mcpState[browser] ?? browser)}</dd>` : ''}
          ${result.release ? `<dt>安装包版本</dt><dd>${e(result.release)}</dd>` : ''}
          ${result.serverIds ? `<dt>Portal 服务 ID</dt><dd>${result.serverIds.map(id => `<code>${e(id)}</code>`).join(' · ')}</dd>` : ''}
          ${result.revocation ? `<dt>撤销</dt><dd>${result.revocation === 'complete' ? '已完成' : '尚未完成，请重试停用'}</dd>` : ''}
          </dl>${back}`));
      }
      if (input.action === 'cancel') {
        const cancelled = await cancelTicket(env.TICKETS, input.deviceId);
        if (wantsJson) return json({ status: cancelled ? 'cancelled' : 'no_pending_ticket' });
        return html(document(cancelled ? '已取消安装票据' : '没有可取消的票据', back));
      }
      if (input.action === 'confirm-disable') {
        const result = await devices.status(input.deviceId);
        if (result.revocation === 'complete') return html(document('远程接入已停用', back));
        return html(document('停用远程接入', `<p>设备 <strong>${e(result.deviceId)}</strong> 的安装票据、Tunnel 凭据和 Portal 路由将被撤销。</p>
          <form method="post" action="/admin/device"><input type="hidden" name="deviceId" value="${e(result.deviceId)}">
          <button class="strong" name="action" value="disable">确认停用</button></form>${back}`));
      }
      if (input.action === 'disable') {
        await devices.disable(input.deviceId);
        if (wantsJson) return json({ status: 'disabled' });
        return html(document('远程接入已停用', back));
      }
    }
    return json({ error: 'Unknown route' }, 404);
  } catch (error) {
    if (url.pathname === activatePath) {
      return error instanceof DeviceError ? json({ error: error.message,
        ...(error.status === 409 && activationErrorCodes.includes(error.activationCode) && { code: error.activationCode }),
      }, error.status) : json({ error: 'Device activation failed' }, 503);
    }
    if (error instanceof EnrollmentAdminError) {
      return wantsJson ? json({ error: error.message, code: error.code }, error.status)
        : html(document('设备操作失败', `<p>${e(error.message)}</p>${back}`), error.status);
    }
    if (error instanceof UpgradeAdminError) return json({ error: error.message, code: error.code }, error.status);
    if (url.pathname.startsWith('/admin/upgrade/')) return json({ error: '无法确认升级状态。请先核对，不要重复提交。' }, 503);
    const expected = error instanceof DeviceError || error instanceof PortalCallbackError;
    const message = expected ? error.message : '请检查 Cloudflare 权限和设备连接后重试。';
    const status = expected ? error.status : 503;
    if (wantsJson || ['/admin/client-callbacks', '/admin/devices/enrollment'].includes(url.pathname)) return json({ error: message }, status);
    return html(document('设备操作失败', `<p>${e(message)}</p>${back}`), status);
  }
}
