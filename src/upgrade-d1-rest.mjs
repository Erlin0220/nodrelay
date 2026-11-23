const account = /^[a-f0-9]{32}$/;
const database = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Adapter for the shared upgrade journal and readiness probes only. The
// caller must independently verify this account/database against the installed
// Worker's live bindings and original receipt. SQL is from checked-in callers;
// no user-supplied SQL, origin, paths, or database selection belongs here.
export function createUpgradeD1Rest(api, { accountId, databaseId } = {}) {
  if (typeof api?.post !== 'function' || typeof accountId !== 'string' || !account.test(accountId) ||
      typeof databaseId !== 'string' || !database.test(databaseId)) {
    throw new Error('无法核对现有管理台的 D1 账户和数据库。未执行升级。');
  }
  const path = '/accounts/' + accountId + '/d1/database/' + databaseId + '/query';
  return Object.freeze({
    prepare(sql) {
      if (typeof sql !== 'string' || sql.length > 4096 || /[;\0]|--|\/\*/.test(sql)) {
        throw new Error('Invalid upgrade D1 statement');
      }
      const mode = sql.trimStart().match(/^(SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1].toUpperCase();
      if (!mode) throw new Error('Invalid upgrade D1 statement');
      const statement = values => Object.freeze({
        bind(...params) {
          if (params.length > 32 || params.some(value => !(typeof value === 'string' && value.length <= 4096) &&
              !(typeof value === 'number' && Number.isSafeInteger(value)))) {
            throw new Error('Invalid upgrade D1 parameters');
          }
          // The REST API specifies string parameters; SQLite applies table
          // affinity to the integer lease fields.
          return statement(params.map(String));
        },
        async first() {
          if (mode !== 'SELECT') throw new Error('Invalid first-row upgrade D1 statement');
          return (await invoke(values)).results[0] ?? null;
        },
        async all() {
          if (mode !== 'SELECT') throw new Error('Invalid read-only upgrade D1 statement');
          return invoke(values);
        },
        async run() {
          if (mode === 'SELECT') throw new Error('Invalid write upgrade D1 statement');
          return invoke(values);
        },
      });
      async function invoke(params) {
        const result = await api.post(path, { sql, params: [...params] });
        const entry = Array.isArray(result) && result.length === 1 ? result[0] : undefined;
        const rows = entry?.results;
        const validRows = Array.isArray(rows) ? rows.every(isObject) : mode !== 'SELECT' && rows == null;
        if (entry?.success !== true || !validRows || (entry.meta !== undefined && !isObject(entry.meta))) {
          throw new Error('Cloudflare 未确认升级数据操作；请核对状态，不要重复提交。');
        }
        // Only the minimal D1 contract needed by the shared coordinator.
        const { meta } = entry;
        return { success: true, results: rows ?? [], ...(meta !== undefined && { meta }) };
      }
      return statement([]);
    },
  });
}
