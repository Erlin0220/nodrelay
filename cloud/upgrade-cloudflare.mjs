const accountId = /^[a-f0-9]{32}$/;
const workerName = /^fleet-[a-z][a-z0-9-]{2,15}-[a-f0-9]{12}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const operationUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,126}$/;
const semver = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.(0|[1-9]\d{0,8}))?$/;
const blocked = new Set(['PROVISIONER_TOKEN', 'FLEET_OAUTH_SEED', 'FLEET_OAUTH_RECONNECT']);
const usage = new Set(['standard', 'bundled', 'unbound']);
const maxWorkerBytes = 8 * 1024 * 1024;

const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const keysOnly = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(field => fields.includes(field));
const etag = value => matches(/^[a-zA-Z0-9_-]{16,128}$/, value);

function reject(message) {
  // Adapter errors are deliberately data-free; do not attach raw response data.
  throw new Error(message);
}

function deployment(value) {
  if (!matches(uuid, value?.id) || value.strategy !== 'percentage' || !Array.isArray(value.versions) ||
      !value.versions.length || value.versions.length > 20) reject('Cloudflare did not return recognizable deployment metadata');
  let total = 0;
  const ids = new Set();
  const versions = value.versions.map(item => {
    if (!matches(uuid, item?.version_id) || ids.has(item.version_id) ||
        !Number.isFinite(item.percentage) || item.percentage < 0.01 || item.percentage > 100) {
      reject('Cloudflare did not return recognizable deployment traffic weights');
    }
    ids.add(item.version_id);
    total += item.percentage;
    return { version_id: item.version_id, percentage: item.percentage };
  });
  if (Math.abs(total - 100) > 1e-8) reject('Cloudflare did not return complete deployment traffic weights');
  return { id: value.id, versions };
}

function normalizeBindings(output, worker) {
  // Cloudflare's generated schema renders this as {}, but the Scripts API
  // wire response is an array of typed bindings (cloudflare-typescript #2652).
  if (!Array.isArray(output) || !output.length) reject('Cloudflare did not return the version binding list');
  const ids = new Set();
  const bindings = output.map(value => {
    if (!matches(identifier, value?.name) || ids.has(value.name) || blocked.has(value.name)) {
      reject('Cloudflare returned incomplete or unsettled Worker bindings');
    }
    const { name, type } = value;
    ids.add(name);
    if (type === 'plain_text' && keysOnly(value, ['name', 'type', 'text']) && typeof value.text === 'string') {
      return { name, type, text: value.text };
    }
    if (type === 'secret_text' && keysOnly(value, ['name', 'type'])) return { name, type };
    if (type === 'd1' && name === 'TICKETS' && keysOnly(value, ['name', 'type', 'database_id', 'id'])) {
      const id = value.database_id ?? value.id;
      if (matches(uuid, id) && (value.id === undefined || value.id === id) &&
          (value.database_id === undefined || value.database_id === id)) return { name, type, id };
    }
    if (type === 'durable_object_namespace' && name === 'PROVISIONER_OAUTH' &&
        keysOnly(value, ['name', 'type', 'namespace_id', 'class_name', 'script_name']) &&
        value.class_name === 'OAuthProvisioner' && matches(accountId, value.namespace_id) &&
        (value.script_name === undefined || value.script_name === worker)) {
      return { name, type, namespace_id: value.namespace_id, class_name: value.class_name };
    }
    reject('Cloudflare returned an unsupported or incomplete Worker version binding');
  });
  if (!bindings.some(value => value.name === 'TICKETS' && value.type === 'd1') ||
      !bindings.some(value => value.name === 'PROVISIONER_OAUTH' && value.type === 'durable_object_namespace')) {
    reject('Cloudflare did not return the D1 and Durable Object binding identities');
  }
  return bindings;
}

function runtimeView(value) {
  const date = value?.compatibility_date;
  // The version API omits an empty compatibility_flags array by design.
  const flags = value?.compatibility_flags === undefined ? [] : value.compatibility_flags;
  if (!matches(/^\d{4}-\d{2}-\d{2}$/, date) || !Array.isArray(flags) ||
      flags.some(flag => !matches(/^[a-z0-9_]{1,100}$/, flag)) || new Set(flags).size !== flags.length ||
      !matches(/^[a-zA-Z0-9_.-]{1,128}$/, value?.migration_tag) || !usage.has(value?.usage_model)) {
    reject('Cloudflare did not return complete runtime or Durable Object migration metadata');
  }
  const provisioner = value.exports?.OAuthProvisioner;
  if (provisioner && (provisioner.type !== 'durable-object' || provisioner.storage !== 'sqlite' ||
      (provisioner.state !== undefined && provisioner.state !== 'created'))) {
    reject('Cloudflare did not identify the existing SQLite Durable Object export');
  }
  return { compatibilityDate: date, compatibilityFlags: [...flags], migrationTag: value.migration_tag, usageModel: value.usage_model };
}

function versionView(value, worker, requestedId) {
  const resources = value?.resources;
  if (value?.id !== requestedId || !etag(resources?.script?.etag)) reject('Cloudflare did not identify the requested Worker version');
  return { id: value.id, etag: resources.script.etag, bindings: normalizeBindings(resources.bindings, worker),
    runtime: runtimeView(resources.script_runtime) };
}

const baselineSettings = Object.freeze([
  'NODRELAY_RELEASE_VERSION', 'NODRELAY_UPGRADE_CHANNEL', 'NODRELAY_UPGRADE_PUBLIC_KEY', 'NODRELAY_UPGRADE_FEED',
]);

const enrollmentSettings = Object.freeze([
  'FLEET_ENROLLMENT_PROTOCOL', 'FLEET_ENROLLMENT_HISTORY', 'FLEET_ENROLLMENT_CATALOG',
]);

function rolloutBindings(list, baseline = false, enrollment = false) {
  if (!Array.isArray(list) || list.length < 2) reject('Incomplete Worker upgrade upload bindings');
  const names = new Set();
  const result = list.map(value => {
    const { name, type } = value ?? {};
    if (!matches(identifier, name) || names.has(name) || blocked.has(name)) reject('Invalid Worker upgrade upload binding');
    names.add(name);
    if (name === 'NODRELAY_RELEASE_VERSION') {
      if (type !== 'plain_text' || !keysOnly(value, ['type', 'name', 'text']) || !matches(semver, value.text)) {
        reject('Invalid Worker upgrade release binding');
      }
      return { name, type, text: value.text };
    }
    if (enrollment && enrollmentSettings.includes(name)) {
      let valid;
      if (name === enrollmentSettings[0]) valid = value.text === 'intent-v1';
      else if (typeof value.text === 'string' && new TextEncoder().encode(value.text).byteLength <= 4096) {
        try {
          const contents = JSON.parse(value.text);
          valid = contents && typeof contents === 'object' && !Array.isArray(contents) && Object.keys(contents).length > 0;
        } catch { valid = false; }
      }
      if (type !== 'plain_text' || !keysOnly(value, ['type', 'name', 'text']) || typeof value.text !== 'string' || !valid) {
        reject('Invalid signed Worker enrollment binding');
      }
      return { name, type, text: value.text };
    }
    if (baseline && baselineSettings.includes(name)) {
      const url = name === 'NODRELAY_UPGRADE_FEED' && typeof value.text === 'string' && URL.parse(value.text);
      const valid = name === 'NODRELAY_UPGRADE_CHANNEL' ? ['stable', 'preview'].includes(value.text)
        : name === 'NODRELAY_UPGRADE_PUBLIC_KEY' ? matches(/^[A-Za-z0-9_-]{59}$/, value.text)
        : url && url.href === value.text && url.protocol === 'https:' && !url.port && !url.username &&
          !url.password && !url.search && !url.hash && url.pathname.endsWith('/');
      if (type !== 'plain_text' || !keysOnly(value, ['type', 'name', 'text']) || !valid) {
        reject('Invalid Worker baseline trust binding');
      }
      return { name, type, text: value.text };
    }
    if (type !== 'inherit' || !keysOnly(value, ['name', 'type'])) reject('A Worker upgrade may only inherit its existing bindings');
    return { name, type };
  });
  for (const name of [...(baseline ? baselineSettings : [baselineSettings[0]]), ...(enrollment ? enrollmentSettings : []), 'TICKETS', 'PROVISIONER_OAUTH', 'TICKET_KEY', 'FLEET_OAUTH_KEY']) {
    if (!names.has(name)) reject('Incomplete Worker upgrade upload bindings');
  }
  return result;
}

// `api` is the existing Cloudflare JSON-envelope client. Pin this instance to
// the authorized account and Worker from server-side settings, never the UI.
export function createCloudflareUpgradeAdapter(api, target, { baseline = false, enrollment = false } = {}) {
  const account = target?.accountId, worker = target?.worker;
  if (baseline === true && enrollment === true || !matches(accountId, account) || !matches(workerName, worker) ||
      typeof api?.get !== 'function' || typeof api?.post !== 'function') reject('Invalid Cloudflare upgrade adapter target');
  const script = '/accounts/' + account + '/workers/scripts/' + worker;
  function assertTarget(input) {
    if (input?.accountId !== account || input.worker !== worker) reject('Cloudflare upgrade adapter target changed');
  }
  return {
    async readDeployment(input) {
      assertTarget(input);
      const query = { page: 1, per_page: 1 };
      // Do not filter by deployable: inheritance uses the latest upload even
      // when it is not currently deployable or serving traffic.
      const [active, latest] = await Promise.all([api.get(script + '/deployments', query), api.get(script + '/versions', query)]);
      if (!Array.isArray(active?.deployments) || !Array.isArray(latest?.items) || !matches(uuid, latest.items[0]?.id)) {
        reject('Cloudflare did not identify the active deployment and latest upload');
      }
      return { deployments: deployment(active.deployments[0]).versions, latestVersion: latest.items[0].id };
    },
    async readVersion(input, id) {
      assertTarget(input);
      if (!matches(uuid, id)) reject('Invalid Cloudflare Worker version ID');
      return versionView(await api.get(script + '/versions/' + id), worker, id);
    },
    async uploadVersion(input, options) {
      assertTarget(input);
      let metadata;
      try {
        if (!keysOnly(options, ['bundle', 'module', 'bindingsInherit', 'bindings', 'compatibilityDate', 'compatibilityFlags',
          'usageModel', 'operationId']) || options.module !== 'worker.js' || options.bindingsInherit !== 'strict' ||
          !matches(operationUuid, options.operationId) || !(options.bundle instanceof Uint8Array) ||
          options.bundle.length < 1 || options.bundle.length > maxWorkerBytes ||
          !matches(/^\d{4}-\d{2}-\d{2}$/, options.compatibilityDate) || !Array.isArray(options.compatibilityFlags) ||
          options.compatibilityFlags.some(flag => !matches(/^[a-z0-9_]{1,100}$/, flag)) ||
          new Set(options.compatibilityFlags).size !== options.compatibilityFlags.length || !usage.has(options.usageModel)) {
          reject('Invalid staged Cloudflare Worker upload input');
        }
        metadata = JSON.stringify({ main_module: 'worker.js',
          compatibility_date: options.compatibilityDate, compatibility_flags: options.compatibilityFlags,
          usage_model: options.usageModel, bindings: rolloutBindings(options.bindings, baseline === true, enrollment === true),
          annotations: { 'workers/tag': options.operationId },
        });
      } catch (error) {
        // Rejected before any request: Cloudflare never received this upload.
        throw Object.assign(error, { notSent: true });
      }
      const body = new FormData();
      body.set('metadata', new Blob([metadata], { type: 'application/json' }));
      body.set('worker.js', new Blob([options.bundle.slice()], { type: 'application/javascript+module' }), 'worker.js');
      const receipt = await api.post(script + '/versions?bindings_inherit=strict', body);
      if (!matches(uuid, receipt?.id) || !etag(receipt.resources?.script?.etag) || receipt.exports_reconciliation !== undefined) {
        reject('Cloudflare did not confirm a code-only staged Worker version');
      }
      return { id: receipt.id, etag: receipt.resources.script.etag };
    },
    // Versions this Worker has that carry an upgrade operation's tag. Every
    // upload sets the tag, so this shows whether an unconfirmed upload landed.
    async taggedVersions(input, tag) {
      assertTarget(input);
      if (!matches(operationUuid, tag)) reject('Invalid Cloudflare upgrade operation tag');
      const listed = await api.get(script + '/versions', { page: 1, per_page: 20 });
      if (!Array.isArray(listed?.items) || listed.items.some(item => !matches(uuid, item?.id))) {
        reject('Cloudflare did not list the Worker versions');
      }
      return listed.items.filter(item => item.annotations?.['workers/tag'] === tag).map(item => item.id);
    },
    async deployVersion(input, options) {
      assertTarget(input);
      const entries = options?.versions;
      if (!keysOnly(options, ['strategy', 'versions']) || options.strategy !== 'percentage' ||
          !Array.isArray(entries) || entries.length !== 1 || !keysOnly(entries[0], ['version_id', 'percentage']) ||
          !matches(uuid, entries[0].version_id) || entries[0].percentage !== 100) {
        reject('Cloudflare upgrade rollout must target exactly one verified version');
      }
      const id = entries[0].version_id;
      const acknowledged = await api.post(script + '/deployments', { strategy: 'percentage',
        versions: [{ version_id: id, percentage: 100 }] });
      // The production API acknowledges a successful Create Deployment with
      // only its UUID. The operation must still read the active versions back.
      if (keysOnly(acknowledged, ['id']) && matches(uuid, acknowledged.id)) return { id: acknowledged.id };
      const response = deployment(acknowledged);
      if (response.versions.length !== 1 || response.versions[0].version_id !== id || response.versions[0].percentage !== 100) {
        reject('Cloudflare did not return the requested full rollout');
      }
      return { id: response.id };
    },
  };
}
