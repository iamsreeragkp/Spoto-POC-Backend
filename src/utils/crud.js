const express = require('express');
const pool = require('../db/pool');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const parseId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'id must be a positive integer');
  return n;
};

/**
 * Builds a full CRUD router for one table.
 *
 * cfg.table      table name (alias "t" is used in baseSelect)
 * cfg.columns    writable columns
 * cfg.required   columns required on create
 * cfg.select     "SELECT ... FROM table t JOIN ..." used by list and get-by-id
 * cfg.filters    { queryParam: { sql, op } } op: eq | ilike | gte | lte
 * cfg.search     SQL expressions searched with ?search= (ILIKE)
 * cfg.sort       { queryParam: sqlExpression } allowed ?sortBy= values
 * cfg.defaultSort  default ORDER BY
 */
function crudRouter(cfg) {
  const router = express.Router();
  const { table, columns, required = [], select, filters = {}, search = [], sort = {}, defaultSort = 't.id ASC' } = cfg;

  const pick = (body, { partial }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be a JSON object');
    const unknown = Object.keys(body).filter((k) => !columns.includes(k));
    if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(', ')}`, { allowed: columns });
    const data = {};
    for (const c of columns) {
      if (body[c] === undefined) continue;
      data[c] = body[c] === '' ? null : body[c];
    }
    if (!partial) {
      const missing = required.filter((c) => data[c] === undefined || data[c] === null);
      if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`);
    } else if (!Object.keys(data).length) {
      throw new HttpError(400, 'No updatable fields supplied', { allowed: columns });
    }
    return data;
  };

  const fetchOne = async (id) => {
    const { rows } = await pool.query(`${select} WHERE t.id = $1`, [id]);
    return rows[0];
  };

  // LIST
  router.get('/', wrap(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const where = [];
    const params = [];
    const add = (v) => { params.push(v); return `$${params.length}`; };

    for (const [param, { sql, op = 'eq' }] of Object.entries(filters)) {
      const v = req.query[param];
      if (v === undefined || v === '') continue;
      if (op === 'ilike') where.push(`${sql} ILIKE ${add(`%${v}%`)}`);
      else if (op === 'gte') where.push(`${sql} >= ${add(v)}`);
      else if (op === 'lte') where.push(`${sql} <= ${add(v)}`);
      else where.push(`${sql} = ${add(v)}`);
    }
    if (req.query.search && search.length) {
      const p = add(`%${req.query.search}%`);
      where.push(`(${search.map((s) => `${s} ILIKE ${p}`).join(' OR ')})`);
    }

    let orderBy = defaultSort;
    if (req.query.sortBy) {
      if (!sort[req.query.sortBy]) throw new HttpError(400, `sortBy must be one of: ${Object.keys(sort).join(', ')}`);
      const dir = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      orderBy = `${sort[req.query.sortBy]} ${dir} NULLS LAST, t.id ASC`;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // count query reuses the select's FROM/JOINs by wrapping it
    const total = Number((await pool.query(`SELECT COUNT(*) FROM (${select} ${whereSql}) c`, params)).rows[0].count);
    const { rows } = await pool.query(
      `${select} ${whereSql} ORDER BY ${orderBy} LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`, params);

    res.json({ data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  }));

  // GET ONE
  router.get('/:id', wrap(async (req, res) => {
    const row = await fetchOne(parseId(req.params.id));
    if (!row) throw new HttpError(404, `${table} not found`);
    res.json({ data: row });
  }));

  // CREATE
  router.post('/', wrap(async (req, res) => {
    const data = pick(req.body, { partial: false });
    const keys = Object.keys(data);
    const { rows } = await pool.query(
      `INSERT INTO ${table}(${keys.join(', ')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => data[k]));
    res.status(201).json({ data: await fetchOne(rows[0].id) });
  }));

  // UPDATE (PUT and PATCH both update only the supplied fields)
  const update = wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const data = pick(req.body, { partial: true });
    const keys = Object.keys(data);
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => data[k]), id]);
    if (!rowCount) throw new HttpError(404, `${table} not found`);
    res.json({ data: await fetchOne(id) });
  });
  router.put('/:id', update);
  router.patch('/:id', update);

  // DELETE
  router.delete('/:id', wrap(async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [parseId(req.params.id)]);
    if (!rows.length) throw new HttpError(404, `${table} not found`);
    res.json({ message: `${table} deleted`, id: rows[0].id });
  }));

  return router;
}

module.exports = { crudRouter, HttpError, wrap, parseId };
