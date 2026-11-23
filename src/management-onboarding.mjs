import { accessNotEnabled } from '../cloud/cloudflare.mjs';
import { isAccessIssuer, accessResourceId } from './setup-core.mjs';
import { InstallationCancelled } from './management-terminal.mjs';

function diagnostic(error, method, route) {
  const status = Number.isInteger(error.status) ? ` HTTP ${error.status}` : '';
  const codes = Array.isArray(error.codes) ? error.codes.filter(Number.isInteger) : [];
  const ray = typeof error.rayId === 'string' && /^[a-zA-Z0-9-]{6,80}$/.test(error.rayId) ? `，Ray ID ${error.rayId}` : '';
  return `${method} /accounts/{account_id}/access/${route}${status}${codes.length ? '，错误码 ' + codes.join(', ') : ''}${ray}`;
}

// Account-wide prerequisite, not a subscription or a management deployment.
// Only explicit absence permits creation; permission failures never do.
export async function ensureManagementAccess(api, accountId, {
  ui, state, save, browse, allowCreate = false, allowNotEnabledMarkerBootstrap = false, providerConsent = false, allowOrganizationCreate = true,
}) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Invalid Cloudflare account');
  const root = `/accounts/${accountId}/access`;
  const dashboard = `https://one.dash.cloudflare.com/${accountId}/`;
  const ledger = state.zeroTrustBootstrap ?? {};
  let createdOrganizationThisRun = false;
  async function handoff(reason) {
    ui.note(`${reason}\n安装器不会选择套餐、提交付款资料或改变账单。若 Cloudflare 要求开通套餐或付款，请本人在官方页面处理。完成后回到这里继续。\n${dashboard}`, 'Cloudflare 首次准备');
    const choice = await ui.select('下一步', [
      { value: 'open', label: '打开官方页面，完成后继续' },
      { value: 'retry', label: '已处理，重新检查' },
      { value: 'cancel', label: '暂不继续' },
    ], 'open');
    if (choice === 'cancel') throw new InstallationCancelled();
    if (choice === 'open') {
      await browse(dashboard);
      if (!await ui.confirm('官方页面已经处理完毕？', '重新检查', true)) throw new InstallationCancelled();
    }
  }
  async function createOnce(kind, path, body, label) {
    if (!allowCreate || ledger[kind]) {
      await handoff(ledger[kind]
        ? `${label}曾发送创建请求，结果尚未能核实。为避免重复创建，不会重发。请核对审计日志并在官方页面完成。`
        : `本次 Cloudflare 授权不包含初始化${label}所需的权限。请在官方页面完成一次设置。`);
      return;
    }
    if (kind === 'organization') {
      if (!await ui.confirm('需要初始化 Zero Trust 组织，是否继续？新管理台优先使用 Cloudflare 账号登录。', '确定', true)) throw new InstallationCancelled();
    } else if (!createdOrganizationThisRun && !providerConsent) {
      if (!await ui.confirm('添加 Cloudflare 账号登录？仅限账户成员，不修改现有登录策略。', '确定', true)) throw new InstallationCancelled();
    }
    ledger[kind] = 'pending';
    state.zeroTrustBootstrap = ledger;
    await save(state); // Must survive lost responses and a killed installer.
    try {
      await api.post(path, body);
      ledger[kind] = 'accepted';
      await save(state);
      if (kind === 'organization') createdOrganizationThisRun = true;
    } catch (error) {
      if (error instanceof InstallationCancelled) throw error;
      // Even a timeout can represent an accepted write. Reconcile by reads;
      // never retry POST based on a missing/temporarily inconsistent result.
      const status = `（${diagnostic(error, 'POST', kind === 'organization' ? 'organizations' : 'identity_providers')}）`;
      await handoff(`${label}创建未能确认${status}。可能是权限、账户资格或网络问题，不能据此认定已开通。请核对官方页面和审计日志。`);
    }
  }
  for (;;) {
    let org;
    try { org = await api.get(root + '/organizations'); }
    catch (error) {
      if (error.status !== 403 && error.status !== 404) throw error;
      const detail = diagnostic(error, 'GET', 'organizations');
      if (error.status === 403 && error.reason === accessNotEnabled) {
        if (allowNotEnabledMarkerBootstrap === true && allowCreate === true) {
          org = null;
        } else {
          await handoff(`Cloudflare 报告此账户尚未启用 Access（${detail}，原因：${accessNotEnabled}）。请在官方页面完成一次设置后继续。`);
          continue;
        }
      } else {
        await handoff(`无法读取 Zero Trust 组织（${detail}）。这不代表组织不存在；请确认账户及组织读取权限。`);
        continue;
      }
    }
    if (org === null) {
      if (!allowOrganizationCreate) throw new Error('原 Zero Trust 组织无法确认，未修改管理台登录配置。');
      await createOnce('organization', root + '/organizations', {}, 'Zero Trust 组织');
      continue;
    }
    const domain = org?.auth_domain;
    const issuer = typeof domain === 'string' && !domain.startsWith('https://') ? `https://${domain}` : domain;
    if (!isAccessIssuer(issuer)) throw new Error('Zero Trust 组织返回无效，已停止，未创建或覆盖组织。');
    let providers;
    try { providers = await api.list(root + '/identity_providers'); }
    catch (error) {
      if (error.status === 403 || error.status === 404) {
        await handoff(`无法确认 Zero Trust 登录方式（${diagnostic(error, 'GET', 'identity_providers')}）。请在官方页面检查，不会按空列表创建。`);
        continue;
      }
      throw error;
    }
    if (!Array.isArray(providers)) throw new Error('Zero Trust 登录方式返回无效，已停止。');
    const otpOnly = providers.length > 0 && providers.every(({ type }) => type === 'onetimepin');
    if (!providers.length || (otpOnly && allowCreate)) {
      await createOnce('cloudflareProvider', root + '/identity_providers', {
        name: 'Cloudflare', type: 'cloudflare', config: { restrict_to_account_members: true },
      }, 'Cloudflare 账号登录方式');
      continue;
    }
    if (otpOnly) ui.info?.('此账户只启用了邮箱验证码。授权初始化权限后，诺联可为管理台配置 Cloudflare 账号登录。');
    const usable = providers.filter(row => accessResourceId.test(row?.id ?? '') && typeof row.type === 'string' && row.type);
    if (!usable.length) throw new Error('已有登录方式无法识别，请管理员检查；安装器不会覆盖现有配置。');
    // Preserve attempted writes as an audit/recovery fact until deployment ends.
    return { issuer, providers: usable };
  }
}
