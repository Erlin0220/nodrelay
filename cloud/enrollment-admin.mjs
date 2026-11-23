import { hostedInstallers } from './device-paths.mjs';
import { draftDevicePredicate } from './devices.mjs';
import { getEnrollmentIntent, issueEnrollmentIntent, revealEnrollmentIntent, revokeEnrollmentIntent } from './enrollment-intents.mjs';
import { devicePattern } from './tickets.mjs';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const valid = (pattern, value) => typeof value === 'string' && pattern.test(value);
const fieldsAre = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

const enrollmentErrors = {
  invalid_target: [400, '设备或安装命令标识无效，请刷新设备列表。'],
  invalid_device: [400, '设备名称或系统选项无效，请检查后重试。'],
  installer_unavailable: [400, '当前版本没有此系统的安装包，请选择设备实际使用的受支持系统。'],
  browser_confirmation: [400, '浏览器权限与所选安装包不匹配，请重新选择系统并核对权限。'],
  device_in_use: [409, '这个设备名称已有接入记录，请查看设备列表或换一个名称。'],
  command_missing: [404, '安装命令已领取、已撤销或不存在，请刷新设备列表。'],
  command_changed: [409, '安装命令状态已变化，请刷新设备列表后再操作。'],
};

export class EnrollmentAdminError extends Error {
  constructor(code) {
    const [status, message] = enrollmentErrors[code];
    super(message);
    this.code = code;
    this.status = status;
  }
}

function validTarget(input) {
  if (!fieldsAre(input, ['deviceId', 'intentId']) || !valid(devicePattern, input.deviceId) || !valid(uuidPattern, input.intentId)) {
    throw new EnrollmentAdminError('invalid_target');
  }
}

// Invoke only after admin authorization and same-origin checks. No network, provisioning,
// or credential access. Wire this only when all creation paths in this device namespace
// share the same fence and legacy creation symmetrically rejects pending/claimed intents.
export function createEnrollmentAdmin({ db, secret, releases, withDeviceFence }) {
  if (!db?.prepare || typeof withDeviceFence !== 'function' || !releases || typeof releases !== 'object' || Array.isArray(releases)) {
    throw new Error('Enrollment database, trusted release catalog and shared device fence are required');
  }
  const installers = hostedInstallers(structuredClone(releases));
  const browserRequired = Object.values(installers).some(release => release.browser === true);

  const existingLegacy = async deviceId => db.prepare(`SELECT
    (SELECT (${draftDevicePredicate}) FROM fleet_devices WHERE id = ?) AS draft,
    EXISTS(SELECT 1 FROM enrollment_tickets WHERE device_id = ? AND expires_at > ?) AS live_ticket`)
    .bind(deviceId, deviceId, Math.floor(Date.now() / 1000)).first();

  const requireNoLegacy = async deviceId => {
    const result = await existingLegacy(deviceId);
    if (result?.live_ticket !== 0 || (result.draft !== null && result.draft !== 1)) {
      throw new EnrollmentAdminError('device_in_use');
    }
    return result.draft === 1;
  };

  const checkedIntent = async ({ deviceId, intentId }) => {
    const intent = await getEnrollmentIntent(db, intentId);
    if (!intent || intent.deviceId !== deviceId || intent.state !== 'pending') {
      throw new EnrollmentAdminError('command_missing');
    }
    return intent;
  };

  return Object.freeze({
    // Whether a multi-system command must first be confirmed for browser tools.
    browserRequired,

    async create(input) {
      const anySystem = fieldsAre(input, ['deviceId', 'confirmBrowser']);
      if (!(anySystem || fieldsAre(input, ['deviceId', 'platform', 'confirmBrowser'])) || !valid(devicePattern, input.deviceId) ||
          (!anySystem && typeof input.platform !== 'string') || typeof input.confirmBrowser !== 'boolean') {
        throw new EnrollmentAdminError('invalid_device');
      }
      const { deviceId, platform, confirmBrowser } = input;
      let pinned;
      if (anySystem) {
        if (!Object.keys(installers).length) throw new EnrollmentAdminError('installer_unavailable');
        if (confirmBrowser !== browserRequired) throw new EnrollmentAdminError('browser_confirmation');
        pinned = { releases: installers };
      } else {
        if (!Object.hasOwn(installers, platform)) throw new EnrollmentAdminError('installer_unavailable');
        const release = installers[platform];
        if (confirmBrowser !== (release?.browser === true)) throw new EnrollmentAdminError('browser_confirmation');
        pinned = { platform, release };
      }
      return withDeviceFence(async assertFence => {
        await assertFence();
        const preparedDraft = await requireNoLegacy(deviceId);
        const reserved = await db.prepare(`SELECT id FROM enrollment_intents
          WHERE device_id = ? AND state IN ('pending', 'claimed') LIMIT 1`).bind(deviceId).first();
        if (reserved) throw new EnrollmentAdminError('device_in_use');
        await assertFence();
        const intent = await issueEnrollmentIntent(db, secret, { deviceId, ...pinned, confirmBrowser });
        if (!intent) throw new EnrollmentAdminError('device_in_use');
        return preparedDraft ? { ...intent, preparedDraft } : intent;
      });
    },

    async reveal(input) {
      validTarget(input);
      const { deviceId, intentId } = input;
      return withDeviceFence(async assertFence => {
        await assertFence();
        await checkedIntent({ deviceId, intentId });
        await requireNoLegacy(deviceId);
        await assertFence();
        const revealed = await revealEnrollmentIntent(db, secret, intentId);
        if (!revealed) throw new EnrollmentAdminError('command_changed');
        return revealed;
      });
    },

    async revoke(input) {
      validTarget(input);
      const { deviceId, intentId } = input;
      return withDeviceFence(async assertFence => {
        await assertFence();
        await checkedIntent({ deviceId, intentId });
        await assertFence();
        const revoked = await revokeEnrollmentIntent(db, intentId);
        if (!revoked) throw new EnrollmentAdminError('command_changed');
        return revoked;
      });
    },
  });
}
