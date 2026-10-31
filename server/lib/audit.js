// Журнал аудита: кто, что и когда изменил. Пишется в той же транзакции, что и изменение.
export async function audit(db, req, { action, entity = null, entityId = null, summary = null, details = null }) {
  await db.query(
    `INSERT INTO audit_log (user_id, username, action, entity, entity_id, summary, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [req?.user?.id ?? null, req?.user?.username ?? (req ? null : 'система'), action, entity, entityId === null ? null : String(entityId), summary, details, req?.ip ?? null],
  );
}

/** Разница между старой и новой версией записи: { поле: [было, стало] } */
export function diff(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(after)) {
    const old = before[k];
    const norm = (x) => (x === null || x === undefined ? null : typeof x === 'object' ? JSON.stringify(x) : String(x));
    if (norm(old) !== norm(v)) out[k] = [old ?? null, v ?? null];
  }
  return out;
}
