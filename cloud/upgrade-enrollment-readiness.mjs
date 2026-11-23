import { enrollmentUpgradeAccessPaths } from './upgrade-enrollment-release.mjs';
import { ensureScopedAccessApp } from './zone-access.mjs';
import { publicAccessApp } from './cloudflare.mjs';

const columns = Object.freeze({
  enrollment_intents: ['id', 'device_id', 'code_digest', 'code_ciphertext', 'snapshot', 'state', 'created_at',
    'resolved_at', 'recovery_digest', 'claimed_architecture'],
  management_upgrade_journal: ['target', 'record'],
});

function exactDestination(current, destination) {
  // A bootstrap application with even one additional destination may
  // bypass management login. Do not attempt to repair it during an upgrade.
  if (current.domain !== undefined && current.domain !== '' && current.domain !== destination) return false;
  const values = current.destinations;
  return Array.isArray(values) && values.length === 1 &&
    values[0]?.type === 'public' && values[0].uri === destination;
}

async function verifySchema(db) {
  for (const [table, names] of Object.entries(columns)) {
    const query = "SELECT name, pk FROM pragma_table_info(?) ORDER BY cid";
    const { results } = await db.prepare(query).bind(table).all();
    if (results?.length !== names.length || !names.every((name, index) => results[index].name === name) ||
        results[0].pk !== 1) throw new Error('Device enrollment requires the expected D1 table schema');
  }
  // A same-name partial UNIQUE index is not sufficient: it must enforce
  // exactly the pending-device invariant from migration 0004. Fail closed on
  // unrecognized index definitions rather than repairing them during upgrade.
  const index = await db.prepare(`SELECT m.sql FROM sqlite_master m
    JOIN pragma_index_list('enrollment_intents') i ON i.name = m.name
    WHERE m.type = 'index' AND m.tbl_name = 'enrollment_intents'
      AND i.name = 'enrollment_intents_pending_device' AND i.[unique] = 1 AND i.partial = 1`).first();
  const expectedIndex = /^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?enrollment_intents_pending_device\s+ON\s+enrollment_intents\s*\(\s*device_id\s*\)\s+WHERE\s+state\s*=\s*'pending'\s*;?$/;
  if (!expectedIndex.test(index?.sql ?? '')) throw new Error('Device enrollment requires the expected pending-device index');
}

function checkedSpec(spec, api) {
  const url = typeof spec?.origin === 'string' && URL.parse(spec.origin);
  if (!url || url.protocol !== 'https:' || url.origin !== spec.origin || url.port ||
      !/^[a-f0-9]{32}$/.test(spec.accountId ?? '') ||
      !/^fleet-[a-z][a-z0-9-]{2,15}-[a-f0-9]{12}$/.test(spec.label ?? '') ||
      spec.label !== spec.worker || spec.accountScopedAccess !== true || spec.zoneScopedAccess ||
      typeof api?.get !== 'function' || typeof api?.list !== 'function') {
    throw new Error('Cannot verify the existing managed deployment enrollment configuration');
  }
  return url;
}

const routeApp = (spec, url, pathname) => publicAccessApp(spec.label + pathname.replaceAll('/', '-'), url.hostname + pathname);

// Interactive command path only: the owner re-ran the installer with a fresh
// grant. Create a missing exact public device route, as the original setup
// does for every hosted system, so a console deployed before a system was
// hosted no longer hides that system's installer behind the management login.
// An existing route that differs is never widened or repaired.
export async function ensureEnrollmentAccessRoutes({ api, spec }) {
  const url = checkedSpec(spec, api);
  if (typeof api.post !== 'function') throw new Error('Cannot add enrollment Access routes without write access');
  const path = '/accounts/' + spec.accountId + '/access/apps';
  const added = [];
  for (const pathname of enrollmentUpgradeAccessPaths) {
    const app = routeApp(spec, url, pathname);
    const existed = (await api.list(path)).some(row => row.name === app.name);
    const found = await ensureScopedAccessApp(api, spec, app, { accountScoped: true, bootstrap: true });
    if (!exactDestination(found, url.hostname + pathname)) throw new Error('An enrollment Access application includes a different or wider route');
    if (!existed) added.push(pathname);
  }
  return added;
}

// Only read provider configuration. Never add a missing Access application,
// widen destinations, or migrate D1 as a side effect of release discovery.
export async function inspectEnrollmentUpgradeReadiness({ api, db, spec }) {
  const url = checkedSpec(spec, api);
  if (typeof db?.prepare !== 'function') throw new Error('Cannot verify the existing managed deployment enrollment configuration');
  await verifySchema(db);
  const path = '/accounts/' + spec.accountId + '/access/apps';
  const listed = await api.list(path);
  const readOnly = {
    get: (...args) => api.get(...args),
    list: (...args) => args[0] === path ? listed : api.list(...args),
    async post() { throw new Error('The original exact enrollment Access application or policy is missing'); },
  };
  const exactAccessRoutes = Object.fromEntries(await Promise.all(enrollmentUpgradeAccessPaths.map(async pathname => {
    const target = url.hostname + pathname;
    const app = routeApp(spec, url, pathname);
    const found = await ensureScopedAccessApp(readOnly, spec, app, { accountScoped: true, bootstrap: true });
    if (!exactDestination(found, target)) throw new Error('An enrollment Access application includes a different or wider route');
    return [pathname, true];
  })));
  return Object.freeze({ verifiedD1: true, exactAccessRoutes: Object.freeze(exactAccessRoutes) });
}
