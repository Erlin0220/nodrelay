import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createUpgradeAdmin } from '../cloud/upgrade-admin.mjs';
import { createCloudflareUpgradeAdapter } from '../cloud/upgrade-cloudflare.mjs';
import { createUpgradeD1Rest } from '../src/upgrade-d1-rest.mjs';
import { upgradeManagementFromCommand } from '../src/management-command-upgrade.mjs';

const installed = '0.1.5-preview.12', update = '0.1.5-preview.13';
const old = '11111111-2222-3333-4444-555555555555', next = '22222222-3333-4444-5555-666666666666';
const after = '44444444-5555-6666-7777-888888888888', webUpdate = '0.1.5-preview.14';
const databaseId = '33333333-4444-5555-6666-777777777777', accessAudience = 'fixture-aud';
// Shaped like the setup receipt: Access scope is recorded only in the deployed FLEET_SPEC.
const spec = { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), worker: 'fleet-demo-111111111111',
  label: 'fleet-demo-111111111111', origin: 'https://fleet.example.test', ownerEmail: 'owner@example.test' };
const script = '/accounts/' + spec.accountId + '/workers/scripts/' + spec.worker;
const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const signed = { feed: 'https://updates.example.test/releases/', channel: 'preview',
  publicKey: Buffer.from(await crypto.subtle.exportKey('spki', key.publicKey)).toString('base64url') };
async function signedRelease(version, minimumVersion) {
  const bundle = Buffer.from('export default {fetch(){return new Response(' + JSON.stringify(version) + ')}};');
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: 'nodrelay-management', channel: 'preview',
    version, minimumVersion, issuedAt: new Date(Date.now()-3600000).toISOString(),
    expiresAt: new Date(Date.now()+86400000).toISOString(), workerBundle: 'worker.js',
    workerSha256: createHash('sha256').update(bundle).digest('hex') }));
  const signature = await crypto.subtle.sign('Ed25519', key.privateKey, manifest);
  return { bundle, manifest, signature };
}
const cliRelease = await signedRelease(update, installed);
const webRelease = await signedRelease(webUpdate, update);
const versionNames = new Map([[old, installed], [next, update], [after, webUpdate]]);
const config = {
  APP_ORIGIN: spec.origin, ACCESS_ISSUER:'https://fixture.cloudflareaccess.com', OWNER_EMAIL: spec.ownerEmail,
  ACCESS_AUD:accessAudience, FLEET_SPEC: JSON.stringify({ ...spec, accountScopedAccess: true }), FLEET_OAUTH_CLIENT_ID:'fixture-client',
  FLEET_OAUTH_MODE:'managed', FLEET_OAUTH_RECOVERY:'1', RELEASE_CATALOG:'{}',
  NODRELAY_UPGRADE_FEED:signed.feed, NODRELAY_UPGRADE_CHANNEL:signed.channel, NODRELAY_UPGRADE_PUBLIC_KEY:signed.publicKey,
};
const version = id => ({ id, resources: {
  script: { etag:'nodrelay_fixture_etag_'+id.slice(0,8) },
  script_runtime:{compatibility_date:'2025-07-01',migration_tag:'fixture-v1',usage_model:'standard'},
  bindings: [...Object.entries({...config,NODRELAY_RELEASE_VERSION:versionNames.get(id)})
    .map(([name,text])=>({name,type:'plain_text',text})),
  { name:'TICKETS',type:'d1',id:databaseId },
  { name:'PROVISIONER_OAUTH',type:'durable_object_namespace',class_name:'OAuthProvisioner',namespace_id:'c'.repeat(32) },
  { name:'TICKET_KEY',type:'secret_text' },{ name:'FLEET_OAUTH_KEY',type:'secret_text' }],
} });
async function fixture(t, { corruptFeed = false, lostDeploy = false, delayDeploy = false, lostUpload = false, posted = false, wrongD1 = false } = {}) {
  const db = new DatabaseSync(':memory:');t.after(()=>db.close());
  for (const file of ['0002_devices.sql','0005_upgrade_journal.sql']) db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  db.prepare("INSERT INTO fleet_devices (id, platform, status, unique_name, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    'fixture-device', 'macos', 'active', 'fixture-device', 1);
  let active = old, latest = posted ? next : old;
  let feed = cliRelease;
  let uploads = 0, deploys = 0, d1Writes = 0, feedReads = 0, feedOffline = false;
  const api = { async get(path) {
    if (path === script+'/deployments') return {deployments:[{ id: databaseId,strategy:'percentage',versions:[{version_id:active,percentage:100}]}]};
    if (path === script+'/versions') return {items:[{id:latest}]};
    const id=path.split('/').at(-1);assert.ok(versionNames.has(id));
    const returned=version(id);
    if(wrongD1) returned.resources.bindings.find(b=>b.name==='TICKETS').id=next;
    return returned;
  }, async post(path, body) {
    if (path.endsWith('/query')) {
      assert.ok(path.endsWith('/'+databaseId+'/query'));
      if(!body.sql.startsWith('SELECT')) d1Writes++;
      const command=db.prepare(body.sql);let results=[];
      if(body.sql.includes('RETURNING')||body.sql.startsWith('SELECT')) results=command.all(...body.params);
      else command.run(...body.params);
      return [{success:true,results}];
    }
    if(path===script+'/versions?bindings_inherit=strict'){
      uploads++;latest=active===old?next:after;
      const metadata=JSON.parse(await body.get('metadata').text());
      assert.deepEqual(metadata.bindings.find(x=>x.name==='TICKETS'),{name:'TICKETS',type:'inherit'});
      assert.deepEqual(metadata.bindings.find(x=>x.name==='PROVISIONER_OAUTH'),{name:'PROVISIONER_OAUTH',type:'inherit'});
      assert.deepEqual(metadata.bindings.find(x=>x.name==='RELEASE_CATALOG'),{name:'RELEASE_CATALOG',type:'inherit'});
      assert.deepEqual(metadata.bindings.find(x=>x.name==='NODRELAY_RELEASE_VERSION'),
        {name:'NODRELAY_RELEASE_VERSION',type:'plain_text',text:versionNames.get(latest)});
      if(lostUpload) throw new Error('lost upload response');
      return {id:latest,resources:{script:version(latest).resources.script}};
    }
    assert.equal(path,script+'/deployments');deploys++;
    assert.deepEqual(body.versions,[{version_id:latest,percentage:100}]);
    if (delayDeploy) throw new Error('rollout not yet visible');
    active=latest;
    if(lostDeploy) throw new Error('lost deploy response');
    return {id:databaseId};
  }};
  const request = async (url, options) => {
    feedReads++; assert.equal(options.credentials,'omit');assert.equal(new Headers(options.headers).has('Authorization'),false);
    if(feedOffline) return new Response(null,{status:503});
    if(url.includes('/v2/')) return new Response(null,{status:404});
    const file=url.slice(signed.feed.length);
    return new Response(file.endsWith('manifest.json.sig') ? feed.signature : file.endsWith('manifest.json') ? feed.manifest :
      corruptFeed ? Buffer.from('tampered') : feed.bundle);
  };
  return {run:()=>upgradeManagementFromCommand({api,spec,databaseId,accessAudience,signed,request}),
    setOffline:()=>{feedOffline=true;},
    showDelayedDeployment:()=>{active=latest;},
    publishNext:()=>{feed=webRelease;},
    web:()=>createUpgradeAdmin({ ...config, NODRELAY_RELEASE_VERSION:versionNames.get(active),
      PROVISIONER_OAUTH:{}, TICKETS:createUpgradeD1Rest(api,{accountId:spec.accountId,databaseId}) }, {
        request,
        oauthAccess:()=> 'fixture.access.token.valid',
        createAdapter:(_provider,target)=>createCloudflareUpgradeAdapter(api,target),
      }),
    device:()=>({...db.prepare('SELECT * FROM fleet_devices WHERE id = ?').get('fixture-device')}),
    snapshot:()=>({active,latest,uploads,deploys,d1Writes,feedReads})};
}

test('rerunning the command deploys the signed release once and the next run is a true no-op', async t => {
  const f=await fixture(t);
  assert.deepEqual(await f.run(),{confirmedVersion:update});
  const done=f.snapshot();
  assert.equal(done.active,next);assert.equal(done.uploads,1);assert.equal(done.deploys,1);
  assert.deepEqual(await f.run(),{currentVersion:update});
  assert.deepEqual(f.snapshot(),{...done,feedReads:done.feedReads+4});
});
test('lost acknowledgement is reconciled before fetching the feed, without another upload or cutover', async t => {
  const f=await fixture(t,{lostDeploy:true});
  await assert.rejects(f.run(),{code:'deployment_unconfirmed'});
  const done=f.snapshot();f.setOffline();
  assert.deepEqual(await f.run(),{confirmedVersion:update});
  assert.equal(f.snapshot().uploads,1);assert.equal(f.snapshot().deploys,1);
  assert.equal(f.snapshot().feedReads,done.feedReads);
});
test('bad signed bytes, wrong D1 ID and an unrelated latest upload fail before writes', async t => {
  for (const options of [{corruptFeed:true},{wrongD1:true},{posted:true}]) {
    const f=await fixture(t,options);
    await assert.rejects(f.run());
    assert.equal(f.snapshot().d1Writes,0);assert.equal(f.snapshot().uploads,0);assert.equal(f.snapshot().deploys,0);
  }
});
test('a possibly accepted upload does not upload again or cut over when rerun', async t => {
  const f=await fixture(t,{lostUpload:true});
  await assert.rejects(f.run(),{code:'upload_unconfirmed'});
  const done=f.snapshot();f.setOffline();
  await assert.rejects(f.run(),/仅核对状态/);
  assert.equal(f.snapshot().active,old);
  assert.equal(f.snapshot().uploads,1);assert.equal(f.snapshot().deploys,0);
  assert.equal(f.snapshot().feedReads,done.feedReads);
});

test('the original command and then the web upgrade share one deployment and preserve its device enrollment', async t => {
  const f = await fixture(t);
  const enrolled = f.device();
  assert.deepEqual(await f.run(), { confirmedVersion: update });
  const admin = f.web();
  assert.deepEqual(await admin.check(), { currentVersion: update });
  assert.equal((await admin.status()).version, update);
  assert.equal(f.snapshot().deploys, 1);

  f.publishNext();
  const check = await admin.check();
  assert.equal(check.nextVersion, webUpdate);
  const operationId = crypto.randomUUID();
  const input = { operationId, version: check.nextVersion, releaseSha256: check.releaseSha256 };
  assert.deepEqual(await admin.start(input), { status:'deployment_confirmed', version:webUpdate, operationId });
  const applied = f.snapshot();
  assert.equal(applied.active, after);
  assert.equal(applied.latest, after);
  assert.equal(applied.uploads, 2);
  assert.equal(applied.deploys, 2);
  assert.deepEqual(f.device(), enrolled);

  const upgraded = f.web();
  assert.deepEqual(await upgraded.status(), { phase:'confirmed', operationId, version:webUpdate, currentVersion:webUpdate });
  assert.deepEqual(await upgraded.check(), { currentVersion:webUpdate });
  assert.deepEqual(await upgraded.start(input), { status:'previously_confirmed', version:webUpdate, operationId });
  assert.deepEqual(await f.run(), { currentVersion:webUpdate });
  assert.deepEqual(f.snapshot(), { ...applied, feedReads:applied.feedReads+8 });
});

test('old traffic after an ambiguous cutover is reported without replay, and late cutover is reconciled', async t => {
  const f = await fixture(t, { delayDeploy: true });
  await assert.rejects(f.run(), { code: 'deployment_unconfirmed' });
  const submitted = f.snapshot();
  f.setOffline();

  const admin = f.web();
  const { phase, operationId } = await admin.status();
  assert.equal(phase, 'deploying');
  assert.deepEqual(await admin.reconcile({ operationId }),
    { status: 'baseline_active_rollout_unconfirmed', version: update, operationId });
  await assert.rejects(f.run(), /流量仍全部指向旧版.*未重新提交/);
  assert.equal((await admin.status()).phase, 'deploying');
  assert.equal(f.snapshot().active, old);

  f.showDelayedDeployment();
  assert.deepEqual(await f.run(), { confirmedVersion: update });
  assert.equal((await f.web().status()).phase, 'confirmed');
  assert.equal(f.snapshot().uploads, submitted.uploads);
  assert.equal(f.snapshot().deploys, submitted.deploys);
  assert.equal(f.snapshot().feedReads, submitted.feedReads);
});
