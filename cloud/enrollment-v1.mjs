import { createEnrollmentAdmin } from './enrollment-admin.mjs';
import { mergeEnrollmentBootstrapHistory } from './enrollment-bootstrap.mjs';
import { deviceLease } from './devices.mjs';
import { findEnrollmentIntentByCode } from './enrollment-intents.mjs';
import { bootstrapInstaller, publicInstallCommand } from './install-command.mjs';

export function enrollmentIsEnabled(env) {
  return env.FLEET_ENROLLMENT_PROTOCOL === 'intent-v1' && Boolean(env.FLEET_ENROLLMENT_HISTORY);
}

export function enrollmentContext(env) {
  if (!enrollmentIsEnabled(env)) return;
  // Existing intent-enabled installations initially shared the legacy catalog.
  // A newer signed publisher may advance only the intent catalog, keeping
  // every legacy ten-minute command on its original approved archive.
  const releases = JSON.parse(env.FLEET_ENROLLMENT_CATALOG ?? env.RELEASE_CATALOG);
  const history = mergeEnrollmentBootstrapHistory(JSON.parse(env.FLEET_ENROLLMENT_HISTORY), releases);
  const hosted = Object.fromEntries(Object.entries(releases).filter(([, asset]) => typeof asset?.url === 'string'));
  const db = env.TICKETS;
  const admin = createEnrollmentAdmin({ db, secret: env.TICKET_KEY, releases: hosted,
    withDeviceFence: run => deviceLease(db, (_options, guard) => run(guard)) });
  return {
    admin, releases: hosted,
    async list() {
      const { results } = await db.prepare(`SELECT id, device_id, snapshot, state FROM enrollment_intents
        WHERE state IN ('pending','claimed') ORDER BY device_id`).all();
      return results.map(row => ({
        id: row.device_id, intentId: row.id, platform: JSON.parse(row.snapshot).platform,
        status: row.state === 'pending' ? 'pending' : 'installing',
      }));
    },
    async registration(deviceId) {
      const row = await db.prepare(`SELECT state FROM enrollment_intents
        WHERE device_id = ? AND state IN ('pending','claimed') LIMIT 1`).bind(deviceId).first();
      return row ? { registration: row.state === 'claimed' ? 'installing' : 'pending' } : undefined;
    },
    lookupApproved(os, version) { return history[os]?.[version]; },
    render(origin, os, group) { return bootstrapInstaller(origin, os, group, { enrollmentIntent: true }); },
    // POST from the public entry script: the install code selects the device
    // and its pinned release, and the console renders that bound installer.
    async launch(origin, os, input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).length !== 1 || typeof input.code !== 'string') return;
      const intent = await findEnrollmentIntentByCode(db, input.code);
      const release = intent?.releases[os];
      if (!release || !Object.values(release.assets).every(asset => asset.url)) return;
      return bootstrapInstaller(origin, os, release, { enrollmentIntent: true, deviceId: intent.deviceId });
    },
    async command(origin, target) {
      const { releases, deviceId, code } = await admin.reveal(target);
      // Every system shares one code. Showing another system's command is a
      // local display change: nothing is written, claimed or provisioned.
      const commands = Object.fromEntries(Object.entries(releases).map(([os, release]) =>
        [os, publicInstallCommand(origin, release.platform, code)]));
      const systems = Object.keys(commands);
      const platform = systems.includes('macos') ? 'macos' : systems[0];
      return { command: commands[platform], commands, deviceId, platform, durable: true };
    },
  };
}
