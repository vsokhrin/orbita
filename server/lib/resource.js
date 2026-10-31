// Универсальный REST-ресурс: список с поиском/фильтрами/сортировкой/пагинацией,
// карточка, создание, изменение с оптимистичной блокировкой, удаление, выгрузка CSV и аудит.
import { HttpError, notFound } from '../http/app.js';
import { validate, parseId } from './validate.js';
import { audit, diff } from './audit.js';
import { toCsv } from './csv.js';
import { requireAuth, canEdit, adminOnly } from '../auth/sessions.js';

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/**
 * Строит WHERE для списка. Фильтры поддерживают перечисление через запятую (status=active,standby),
 * а также диапазоны для дат: from/to по полю dateField.
 */
export function buildWhere(def, query, startIndex = 1) {
  const where = [];
  const params = [];
  let i = startIndex;
  if (query.q && def.search?.length) {
    const term = '%' + escapeLike(String(query.q).trim().slice(0, 100)) + '%';
    params.push(term);
    where.push('(' + def.search.map((c) => `${c}::text ILIKE $${i}`).join(' OR ') + ')');
    i++;
  }
  for (const [key, column] of Object.entries(def.filters || {})) {
    const raw = query[key];
    if (raw === undefined || raw === '') continue;
    const values = String(raw).split(',').filter(Boolean).slice(0, 20);
    if (raw === 'null') {
      where.push(`${column} IS NULL`);
      continue;
    }
    params.push(values);
    where.push(`${column}::text = ANY($${i}::text[])`);
    i++;
  }
  if (def.dateField) {
    if (query.from && !Number.isNaN(Date.parse(query.from))) {
      params.push(new Date(query.from).toISOString());
      where.push(`${def.dateField} >= $${i++}`);
    }
    if (query.to && !Number.isNaN(Date.parse(query.to))) {
      params.push(new Date(query.to).toISOString());
      where.push(`${def.dateField} <= $${i++}`);
    }
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, next: i };
}

export function buildOrder(def, query) {
  const col = def.sortable?.[query.sort];
  if (!col) return 'ORDER BY ' + (def.defaultSort || 'id DESC');
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${col} ${dir} NULLS LAST, id ${dir}`;
}

export function resource(app, db, def) {
  const { path, table, entity, schema } = def;
  const select = def.select || `SELECT * FROM ${table}`;
  const writeGuard = def.writeGuard || canEdit;
  const deleteGuard = def.deleteGuard || adminOnly;

  const getOne = (conn, id) => conn.one(`SELECT * FROM (${select}) q WHERE id = $1`, [id]);

  // Список
  app.get(path, requireAuth, async (req) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const where = buildWhere(def, req.query);
    const rows = await db.many(
      `SELECT q.*, count(*) OVER() AS _total FROM (${select}) q ${where.sql} ${buildOrder(def, req.query)}
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      where.params,
    );
    const total = rows[0]?._total ?? 0;
    for (const r of rows) delete r._total;
    return { items: rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
  });

  // Выгрузка CSV с теми же фильтрами, что и список
  if (def.csv) {
    app.get(path + '.csv', requireAuth, async (req, res) => {
      const where = buildWhere(def, req.query);
      const rows = await db.many(`SELECT q.* FROM (${select}) q ${where.sql} ${buildOrder(def, req.query)} LIMIT 20000`, where.params);
      const date = new Date().toISOString().slice(0, 10);
      res.send(toCsv(rows, def.csv), 200, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="orbita-${entity}-${date}.csv"`,
        'Cache-Control': 'no-store',
      });
    });
  }

  // Карточка
  app.get(path + '/:id', requireAuth, async (req) => {
    const row = await getOne(db, parseId(req.params.id));
    if (!row) throw notFound();
    return def.expand ? def.expand(row, db, req) : row;
  });

  // Создание
  app.post(path, writeGuard, async (req, res) => {
    const values = validate(schema, req.body);
    if (def.beforeSave) await def.beforeSave(values, null, req);
    const row = await db.transaction(async (tx) => {
      const cols = Object.keys(values);
      const inserted = await tx.one(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, k) => '$' + (k + 1)).join(', ')}) RETURNING id`,
        cols.map((c) => values[c]),
      );
      const full = await getOne(tx, inserted.id);
      await audit(tx, req, { action: 'create', entity, entityId: inserted.id, summary: def.title(full), details: values });
      return full;
    });
    def.afterChange?.('create', row, req);
    res.json(row, 201);
  });

  // Изменение (частичное). Поле _version (updated_at) включает оптимистичную блокировку.
  app.put(path + '/:id', writeGuard, async (req) => {
    const id = parseId(req.params.id);
    const values = validate(schema, req.body, { partial: true });
    const row = await db.transaction(async (tx) => {
      const before = await tx.one(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound();
      if (req.body._version && before.updated_at && req.body._version !== before.updated_at) {
        throw new HttpError(409, 'Запись уже изменил другой пользователь. Обновите страницу и повторите правку.');
      }
      if (def.beforeSave) await def.beforeSave(values, before, req);
      const changes = diff(before, values);
      if (Object.keys(changes).length) {
        const cols = Object.keys(changes);
        await tx.query(
          `UPDATE ${table} SET ${cols.map((c, k) => `${c} = $${k + 2}`).join(', ')} WHERE id = $1`,
          [id, ...cols.map((c) => values[c])],
        );
        const full = await getOne(tx, id);
        await audit(tx, req, { action: 'update', entity, entityId: id, summary: def.title(full), details: changes });
        return { full, changed: true };
      }
      return { full: await getOne(tx, id), changed: false };
    });
    if (row.changed) def.afterChange?.('update', row.full, req);
    return row.full;
  });

  // Удаление
  app.delete(path + '/:id', deleteGuard, async (req, res) => {
    const id = parseId(req.params.id);
    const removed = await db.transaction(async (tx) => {
      const before = await getOne(tx, id);
      if (!before) throw notFound();
      if (def.beforeDelete) await def.beforeDelete(before, tx, req);
      await tx.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      await audit(tx, req, { action: 'delete', entity, entityId: id, summary: def.title(before) });
      return before;
    });
    def.afterChange?.('delete', removed, req);
    res.noContent();
  });

  return { getOne };
}
