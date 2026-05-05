// src/routes/profiles.js
//
// Profile endpoints — TRD spec (Stage 3, unchanged) + Stage 4B additions:
//
//   GET    /api/profiles               — list (filters, sort, pagination, NL search)
//   GET    /api/profiles/search        — natural language search
//   GET    /api/profiles/export        — CSV export (?format=csv required)
//   GET    /api/profiles/:id           — single profile
//   POST   /api/profiles               — create (admin only)
//   DELETE /api/profiles/:id           — delete (admin only)
//   POST   /api/profiles/import        — CSV bulk upload (admin only) [Stage 4B]
//   GET    /api/profiles/cache-stats   — cache diagnostics [Stage 4B]
//
// Stage 4B changes:
//   - GET / and GET /search check the LRU cache before querying the DB
//   - Filters are normalized before cache lookup so semantically equivalent
//     queries hit the same cache entry
//   - POST, DELETE, and /import invalidate the cache after writes
//   - /import streams the uploaded CSV in chunks; does not load file into memory

import { Router } from 'express';
import { stringify } from 'csv-stringify/sync';
import axios from 'axios';
import { unlink } from 'node:fs/promises';
import { protect, requireRole } from '../middleware/auth.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { sendSuccess, sendError, sendPaginated } from '../utils/response.js';
import { parseNaturalLanguageQuery } from '../services/nlpSearch.js';
import { queryCache } from '../services/queryCache.js';
import { normalizeFilters, makeCacheKey } from '../services/queryNormalizer.js';
import { processCSV } from '../services/csvIngestion.js';
import { uploadCSV } from '../middleware/upload.js';
import db, { uuidv7 } from '../config/database.js';

const router = Router();

router.use(...protect, apiLimiter);

// ---------------------------------------------------------------------------
// QUERY BUILDER (unchanged from Stage 3)
// ---------------------------------------------------------------------------
function buildWhere(filters) {
  const conditions = [];
  const params = [];

  if (filters.gender) {
    conditions.push('LOWER(gender) = LOWER(?)');
    params.push(filters.gender);
  }
  if (filters.country_id) {
    conditions.push('UPPER(country_id) = UPPER(?)');
    params.push(filters.country_id);
  }
  if (filters.country_name) {
    conditions.push('LOWER(country_name) LIKE LOWER(?)');
    params.push(`%${filters.country_name}%`);
  }
  if (filters.age_group) {
    conditions.push('LOWER(age_group) = LOWER(?)');
    params.push(filters.age_group);
  }
  if (filters.min_age !== undefined) {
    conditions.push('age >= ?');
    params.push(parseInt(filters.min_age));
  }
  if (filters.max_age !== undefined) {
    conditions.push('age <= ?');
    params.push(parseInt(filters.max_age));
  }
  if (filters.search) {
    conditions.push('(LOWER(name) LIKE LOWER(?) OR LOWER(country_name) LIKE LOWER(?))');
    const t = `%${filters.search}%`;
    params.push(t, t);
  }

  return {
    whereClause: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

const SORTABLE = ['name', 'age', 'gender', 'country_name', 'created_at', 'gender_probability'];

function getSortParams(sortBy, order) {
  const col = SORTABLE.includes(sortBy) ? sortBy : 'created_at';
  const dir = order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${col} ${dir}`;
}

// ---------------------------------------------------------------------------
// GET /api/profiles
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const {
    gender, country_id, country_name, age_group,
    min_age, max_age, search,
    sort_by, order, page: pageQ, limit: limitQ,
  } = req.query;

  const page  = Math.max(1, parseInt(pageQ) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(limitQ) || 10));

  // Normalize filters → deterministic cache key
  const rawFilters = { gender, country_id, country_name, age_group, min_age, max_age, search };
  const normalized = normalizeFilters(rawFilters);
  const cacheKey   = makeCacheKey(normalized, page, limit, sort_by, order);

  // Cache hit → return immediately, no DB query
  const cached = queryCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  // Cache miss → query DB
  const { whereClause, params } = buildWhere(normalized);
  const orderClause = getSortParams(sort_by, order);
  const offset = (page - 1) * limit;

  const total    = db.prepare(`SELECT COUNT(*) as c FROM profiles ${whereClause}`).get(...params).c;
  const profiles = db.prepare(
    `SELECT * FROM profiles ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const queryObj = {};
  if (normalized.gender)       queryObj.gender       = normalized.gender;
  if (normalized.country_id)   queryObj.country_id   = normalized.country_id;
  if (normalized.age_group)    queryObj.age_group     = normalized.age_group;
  if (normalized.search)       queryObj.search        = normalized.search;
  if (sort_by)                 queryObj.sort_by       = sort_by;
  if (order)                   queryObj.order         = order;

  // Build the response payload and cache it
  // We reconstruct sendPaginated's output so we can store + return the same shape
  const baseUrl  = `/api/profiles`;
  const selfUrl  = buildPaginatedUrl(baseUrl, queryObj, page, limit);
  const nextUrl  = page * limit < total ? buildPaginatedUrl(baseUrl, queryObj, page + 1, limit) : null;
  const prevUrl  = page > 1            ? buildPaginatedUrl(baseUrl, queryObj, page - 1, limit) : null;

  const payload = {
    status: 'success',
    data: profiles,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    links: { self: selfUrl, next: nextUrl, prev: prevUrl },
  };

  queryCache.set(cacheKey, payload);
  return res.json(payload);
});

// ---------------------------------------------------------------------------
// GET /api/profiles/search  — natural language search
// ---------------------------------------------------------------------------
router.get('/search', (req, res) => {
  const rawQuery = req.query.q || req.query.query || '';
  if (!rawQuery.trim()) {
    return sendError(res, 'Query parameter ?q is required', 400);
  }

  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));

  // Parse NL → structured filters → normalize → cache key
  const nlFilters  = parseNaturalLanguageQuery(rawQuery);
  if (Object.keys(nlFilters).length === 0) nlFilters.search = rawQuery;

  const normalized = normalizeFilters(nlFilters);
  // Include the raw query in the key so different NL inputs that map to the
  // same filters still share the same cache entry.
  const cacheKey = makeCacheKey(normalized, page, limit, 'created_at', 'desc');

  const cached = queryCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const { whereClause, params } = buildWhere(normalized);
  const offset = (page - 1) * limit;

  const total    = db.prepare(`SELECT COUNT(*) as c FROM profiles ${whereClause}`).get(...params).c;
  const profiles = db.prepare(
    `SELECT * FROM profiles ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const baseUrl = `/api/profiles/search`;
  const selfUrl = buildPaginatedUrl(baseUrl, { q: rawQuery }, page, limit);
  const nextUrl = page * limit < total ? buildPaginatedUrl(baseUrl, { q: rawQuery }, page + 1, limit) : null;
  const prevUrl = page > 1             ? buildPaginatedUrl(baseUrl, { q: rawQuery }, page - 1, limit) : null;

  const payload = {
    status: 'success',
    data: profiles,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    links: { self: selfUrl, next: nextUrl, prev: prevUrl },
  };

  queryCache.set(cacheKey, payload);
  return res.json(payload);
});

// ---------------------------------------------------------------------------
// GET /api/profiles/export?format=csv (unchanged)
// ---------------------------------------------------------------------------
router.get('/export', (req, res) => {
  if (req.query.format !== 'csv') {
    return sendError(res, 'Only ?format=csv is supported', 400);
  }

  const { gender, country_id, country_name, age_group, min_age, max_age, search } = req.query;
  const { whereClause, params } = buildWhere({ gender, country_id, country_name, age_group, min_age, max_age, search });

  const profiles = db.prepare(
    `SELECT id, name, gender, gender_probability, age, age_group,
            country_id, country_name, country_probability, created_at
     FROM profiles ${whereClause} ORDER BY created_at DESC`
  ).all(...params);

  const csv = stringify(profiles, {
    header: true,
    columns: ['id', 'name', 'gender', 'gender_probability', 'age', 'age_group',
               'country_id', 'country_name', 'country_probability', 'created_at'],
    delimiter: ',',
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="profiles_${timestamp}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// GET /api/profiles/cache-stats  — diagnostic endpoint (Stage 4B)
// ---------------------------------------------------------------------------
router.get('/cache-stats', (req, res) => {
  return sendSuccess(res, { cache: queryCache.stats() });
});

// ---------------------------------------------------------------------------
// GET /api/profiles/:id (unchanged)
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!profile) return sendError(res, 'Profile not found', 404);
  return sendSuccess(res, { data: profile });
});

// ---------------------------------------------------------------------------
// POST /api/profiles  (unchanged; invalidates cache on success)
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return sendError(res, 'name is required', 400);

  // Idempotency: reject if name already exists
  const existing = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?)').get(name.trim());
  if (existing) return sendError(res, 'A profile with this name already exists', 409);

  try {
    const [genderRes, ageRes, nationalityRes] = await Promise.allSettled([
      axios.get(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
      axios.get(`https://api.agify.io?name=${encodeURIComponent(name)}`),
      axios.get(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
    ]);

    const genderData      = genderRes.status === 'fulfilled'      ? genderRes.value.data      : {};
    const ageData         = ageRes.status === 'fulfilled'         ? ageRes.value.data         : {};
    const nationalityData = nationalityRes.status === 'fulfilled' ? nationalityRes.value.data : {};

    const age = ageData.age ?? null;
    let age_group = null;
    if (age !== null) {
      if (age < 18) age_group = 'young-adult';
      else if (age < 35) age_group = 'adult';
      else if (age < 55) age_group = 'middle-aged';
      else age_group = 'senior';
    }

    const topNationality = nationalityData.country?.[0] ?? null;

    const COUNTRY_NAMES = {
      US: 'United States', GB: 'United Kingdom', NG: 'Nigeria', GH: 'Ghana',
      DE: 'Germany', FR: 'France', BR: 'Brazil', KR: 'South Korea',
      IN: 'India', CA: 'Canada', AU: 'Australia', ZA: 'South Africa',
      KE: 'Kenya', EG: 'Egypt', JP: 'Japan', CN: 'China',
    };

    const countryId   = topNationality?.country_id ?? null;
    const countryName = countryId ? (COUNTRY_NAMES[countryId] ?? countryId) : null;

    const id = uuidv7();
    db.prepare(`
      INSERT INTO profiles
        (id, name, gender, gender_probability, age, age_group,
         country_id, country_name, country_probability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name.trim(),
      genderData.gender ?? null,
      genderData.probability ?? null,
      age, age_group, countryId, countryName,
      topNationality?.probability ?? null,
    );

    queryCache.invalidate(); // New data — stale cache results must not be served

    const created = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return sendSuccess(res, { data: created }, 201);
  } catch (err) {
    return sendError(res, `Failed to create profile: ${err.message}`, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/profiles/import  — CSV bulk upload (Stage 4B, admin only)
//
// Flow:
//   1. multer saves the uploaded file to disk (no memory buffering)
//   2. processCSV() streams it line-by-line, validates and batch-inserts rows
//   3. The temp file is deleted regardless of success or failure
//   4. The query cache is invalidated (processCSV does this internally)
//   5. Summary stats are returned
//
// The route is defined BEFORE /:id to avoid Express matching 'import' as an ID.
// ---------------------------------------------------------------------------
router.post('/import', requireRole('admin'), (req, res) => {
  // Run multer as a callback so we can return proper JSON errors instead of
  // multer's default HTML error responses.
  uploadCSV(req, res, async (err) => {
    if (err) {
      return sendError(res, err.message, 400);
    }
    if (!req.file) {
      return sendError(res, 'No file uploaded. Send a CSV as form-data field "file".', 400);
    }

    const filePath = req.file.path;

    try {
      const stats = await processCSV(filePath);
      return res.json({
        status: 'success',
        total_rows: stats.total_rows,
        inserted: stats.inserted,
        skipped: stats.skipped,
        reasons: stats.reasons,
      });
    } catch (processingErr) {
      console.error('[import] Processing error:', processingErr);
      return sendError(res, `CSV processing failed: ${processingErr.message}`, 500);
    } finally {
      // Always clean up the temp file — success or failure
      unlink(filePath).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/profiles/:id  (unchanged; invalidates cache on success)
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!profile) return sendError(res, 'Profile not found', 404);

  db.prepare('DELETE FROM profiles WHERE id = ?').run(req.params.id);
  queryCache.invalidate(); // Deleted row must not appear in cached results

  return sendSuccess(res, { message: 'Profile deleted', id: req.params.id });
});

// ---------------------------------------------------------------------------
// Internal helper: build paginated URL with query params
// ---------------------------------------------------------------------------
function buildPaginatedUrl(base, query, page, limit) {
  const params = new URLSearchParams({ ...query, page, limit });
  return `${base}?${params.toString()}`;
}

export default router;
