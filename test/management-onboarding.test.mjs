import test from 'node:test';
import assert from 'node:assert/strict';
import { accessNotEnabled } from '../cloud/cloudflare.mjs';
import { ensureManagementAccess } from '../src/management-onboarding.mjs';
import { InstallationCancelled } from '../src/management-terminal.mjs';
import { registrationSpec } from '../src/oauth-registration.mjs';
import { managementBootstrapOAuthScopes, runtimeGrant } from '../cloud/oauth-grant.mjs';
const account = 'a'.repeat(32);
const provider = { id: 'b'.repeat(32), type: 'cloudflare' };
const org = { auth_domain: 'test.cloudflareaccess.com' };
function fixture(overrides = {}) {
  const state = {}, calls = [];
  const api = { get: async () => org, list: async () => [provider], post: async (...args) => calls.push(args), ...overrides };
  const ui = { note() {}, confirm: async () => true, select: async () => 'cancel' };
  const options = { ui, state, save: async () => calls.push(['save', structuredClone(state)]), browse: async () => {}, allowCreate: true };
  return { api, options, calls, state };
}
test('existing organization and provider are read only', async () => {
  for (const allowCreate of [false, true]) {
    const f = fixture();
    assert.equal((await ensureManagementAccess(f.api, account, { ...f.options, allowCreate })).issuer, 'https://test.cloudflareaccess.com');
    assert.deepEqual(f.calls, []);
  }
});
test('explicit absence creates organization with provider-generated name, then native login; intent saved first', async () => {
  let organization=null, providers=[];
  const f=fixture({get:async()=>organization,list:async()=>providers,post:async(path,body)=>{
    assert.equal(f.calls.at(-1)[0],'save');
    if(path.endsWith('/organizations')) { assert.deepEqual(body,{}); organization=org; }
    else {assert.deepEqual(body,{name:'Cloudflare',type:'cloudflare',config:{restrict_to_account_members:true}});providers=[provider];}
  }});
  const prompts = [];
  f.options.ui.confirm = async (...args) => { prompts.push(args); return true; };
  const r=await ensureManagementAccess(f.api,account,f.options);
  assert.deepEqual(prompts, [['需要初始化 Zero Trust 组织，是否继续？新管理台优先使用 Cloudflare 账号登录。', '确定', true]]);
  assert.equal(r.providers.length,1);assert.equal(f.state.zeroTrustBootstrap.organization,'accepted');assert.equal(f.state.zeroTrustBootstrap.cloudflareProvider,'accepted');
});
test('403 is not absence and never posts; user may fix permission and continue', async () => {
  let reads=0; const f=fixture({get:async()=>{if(!reads++)throw Object.assign(new Error(),{status:403});return org;}});
  f.options.ui.select=async()=> 'retry'; await ensureManagementAccess(f.api,account,f.options);assert.deepEqual(f.calls,[]);
});
test('explicit null organization permits creation but 404 provider list never does', async()=>{
  let reads=0;const f=fixture({get:async()=>!reads++ ? null : org,list:async()=>{throw Object.assign(new Error(),{status:404});}});
  await assert.rejects(ensureManagementAccess(f.api,account,f.options),InstallationCancelled);
  assert.equal(f.calls.filter(x=>String(x[0]).endsWith('/organizations')).length,1);assert.equal(f.calls.filter(x=>String(x[0]).endsWith('/identity_providers')).length,0);
});
test('missing initialization capability guides browser and continues without API writes',async()=>{
  let organization=null;const f=fixture({get:async()=>organization});f.options.allowCreate=false;f.options.ui.select=async()=> 'open';f.options.ui.confirm=async(...args)=>{assert.deepEqual(args,['官方页面已经处理完毕？','重新检查',true]);return true;};f.options.browse=async(url)=>{assert.equal(url,`https://one.dash.cloudflare.com/${account}/`);organization=org;};await ensureManagementAccess(f.api,account,f.options);assert.deepEqual(f.calls,[]);
});
test('lost POST reply is not replayed, including subsequent run',async()=>{
  let posts=0;const f=fixture({get:async()=>null,post:async()=>{posts++;throw new Error('lost response');}});
  await assert.rejects(ensureManagementAccess(f.api,account,f.options),InstallationCancelled);
  await assert.rejects(ensureManagementAccess(f.api,account,f.options),InstallationCancelled);
  assert.equal(posts,1);assert.equal(f.state.zeroTrustBootstrap.organization,'pending');
});
test('save failure occurs before any create',async()=>{const f=fixture({get:async()=>null});f.options.save=async()=>{throw Error('disk');};await assert.rejects(ensureManagementAccess(f.api,account,f.options),/disk/);assert.deepEqual(f.calls,[]);});
test('malformed existing organization is not overwritten',async()=>{const f=fixture({get:async()=>({})});await assert.rejects(ensureManagementAccess(f.api,account,f.options),/返回无效/);assert.deepEqual(f.calls,[]);});
test('cancelling initialization makes no writes',async()=>{const f=fixture({get:async()=>null});f.options.ui.confirm=async()=>false;await assert.rejects(ensureManagementAccess(f.api,account,f.options),InstallationCancelled);assert.deepEqual(f.calls,[]);});
test('the missing native provider prompt defaults to 确定; selecting 取消 does not write', async () => {
  const f = fixture({ list: async () => [] });
  f.options.ui.confirm = async (...args) => {
    assert.deepEqual(args, ['添加 Cloudflare 账号登录？仅限账户成员，不修改现有登录策略。', '确定', true]);
    return false;
  };
  await assert.rejects(ensureManagementAccess(f.api, account, f.options), InstallationCancelled);
  assert.deepEqual(f.calls, []);
});
test('existing SSO is preserved instead of adding native login',async()=>{const f=fixture({list:async()=>[{...provider,type:'oidc'}]});assert.equal((await ensureManagementAccess(f.api,account,f.options)).providers[0].type,'oidc');assert.deepEqual(f.calls,[]);});
test('publisher bootstrap capability adds optional account write, legacy registration unchanged',()=>{
 const config={accountId:account,namespace:'nodrelay',oauthRedirect:'http://127.0.0.1:18871/oauth/callback'};
 const legacy=registrationSpec(config,[],{management:true}).body;
 const next=registrationSpec({...config,zeroTrustBootstrap:true},[],{management:true}).body;
 assert(!legacy.scopes.includes('access-acct.write'));assert(next.scopes.includes('access-acct.write'));assert(next.optional_scopes.includes('access-acct.write'));
 const token={access_token:'a'.repeat(30),refresh_token:'r'.repeat(30),expires_in:3600,token_type:'bearer',scope:managementBootstrapOAuthScopes.join(' ')};
 assert(runtimeGrant(token,undefined,managementBootstrapOAuthScopes).access);
});
test('handoff retains safe diagnostic code and Ray ID, not raw response', async()=>{
 const f=fixture({get:async()=>{throw Object.assign(new Error('secret-response'),{status:403,codes:[9999],rayId:'8abc1234-SJC'});}});
 let message='';f.options.ui.note=text=>message+=text;
 await assert.rejects(ensureManagementAccess(f.api,account,f.options),InstallationCancelled);
 assert.match(message,/HTTP 403.*9999.*8abc1234-SJC/);assert.doesNotMatch(message,/secret-response/);
});
test('SIGINT cancellation is not relabelled as an onboarding failure', async()=>{
 const f=fixture({get:async()=>null,post:async()=>{throw new InstallationCancelled();}});
 f.options.ui.select=()=>assert.fail('Cancellation must not open a handoff prompt');
 await assert.rejects(ensureManagementAccess(f.api,account,f.options),InstallationCancelled);
});

test('the disabled marker is diagnostic-only by default, and always without the actual write grant', async () => {
  for (const [allowCreate, allowNotEnabledMarkerBootstrap] of [[true, undefined], [false, true]]) {
    let note = '';
    const f = fixture({ get: async () => { throw Object.assign(new Error(), { status: 403, reason: accessNotEnabled }); } });
    f.options.ui.note = text => { note += text; };
    await assert.rejects(ensureManagementAccess(f.api, account, { ...f.options, allowCreate, allowNotEnabledMarkerBootstrap }), InstallationCancelled);
    assert.match(note, /access_not_enabled/);
    assert.deepEqual(f.calls, []);
  }
});

test('allow-listed marker with migration gate and grant initializes once after confirmation', async () => {
  let missing = true;
  const f = fixture({
    get: async () => {
      if (missing) throw Object.assign(new Error(), { status: 403, reason: accessNotEnabled });
      return org;
    },
    post: async (path, body) => {
      assert.deepEqual(body, {});
      assert.equal(f.state.zeroTrustBootstrap.organization, 'pending');
      assert.equal(f.calls.at(-1)[0], 'save');
      f.calls.push([path, body]);
      missing = false;
    },
  });
  await ensureManagementAccess(f.api, account, { ...f.options, allowNotEnabledMarkerBootstrap: true });
  assert.equal(f.calls.filter(([path]) => path.endsWith('/organizations')).length, 1);
  assert.equal(f.state.zeroTrustBootstrap.organization, 'accepted');
});

test('unclassified 403 or 404 do not trigger creation regardless of the grant and migration gate', async () => {
  for (const status of [403, 404]) {
    const f = fixture({ get: async () => { throw Object.assign(new Error(), { status, codes: [status === 403 ? 9999 : 7003] }); } });
    await assert.rejects(ensureManagementAccess(f.api, account, { ...f.options, allowNotEnabledMarkerBootstrap: true }), InstallationCancelled);
    assert.deepEqual(f.calls, []);
  }
});

test('ambiguous marker-triggered organization create is never replayed across runs', async () => {
  let writes = 0;
  const f = fixture({
    get: async () => { throw Object.assign(new Error(), { status: 403, reason: accessNotEnabled }); },
    post: async () => { writes++; throw new Error('connection lost'); },
  });
  const options = { ...f.options, allowNotEnabledMarkerBootstrap: true };
  await assert.rejects(ensureManagementAccess(f.api, account, options), InstallationCancelled);
  await assert.rejects(ensureManagementAccess(f.api, account, options), InstallationCancelled);
  assert.equal(writes, 1);
  assert.equal(f.state.zeroTrustBootstrap.organization, 'pending');
});

test('legacy OTP-only organization gains native login without changing OTP', async () => {
  const otp = { id: 'c'.repeat(32), type: 'onetimepin' };
  const choices = [], providers = [otp];
  const f = fixture({ list: async () => providers, post: async (path, body) => {
    assert.match(path, /identity_providers$/);
    assert.equal(body.type, 'cloudflare');
    providers.push(provider);
  } });
  f.options.ui.confirm = async (...args) => { choices.push(args); return true; };
  assert.deepEqual((await ensureManagementAccess(f.api, account, f.options)).providers, [otp, provider]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0][2], true);
  assert.deepEqual((await ensureManagementAccess(f.api, account, f.options)).providers, [otp, provider]);
  assert.equal(choices.length, 1);
});
