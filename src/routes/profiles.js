// src/routes/profiles.js
//
// Profile endpoints — TRD spec:
//
//   GET    /api/profiles               — list (filters, sort, pagination, NL search)
//   GET    /api/profiles/search        — natural language search (same response shape)
//   GET    /api/profiles/export        — CSV export (?format=csv required)
//   GET    /api/profiles/:id           — single profile
//   POST   /api/profiles               — create (admin only, calls external APIs)
//   DELETE /api/profiles/:id           — delete (admin only)
//
// TRD REQUIREMENTS:
//   - X-API-Version: 1 header required (enforced by parent router middleware)
//   - Paginated responses include links: { self, next, prev }
//   - Admins: full access; Analysts: read + search + export only
//   - CSV: id, name, gender, gender_probability, age, age_group,
//          country_id, country_name, country_probability, created_at

import { Router } from 'express';
import { stringify } from 'csv-stringify/sync';
import axios from 'axios';
import { protect, requireRole } from '../middleware/auth.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { sendSuccess, sendError, sendPaginated } from '../utils/response.js';
import { parseNaturalLanguageQuery } from '../services/nlpSearch.js';
import db, { uuidv7 } from '../config/database.js';

const router = Router();

// All profile routes require authentication + active account + rate limiting
router.use(...protect, apiLimiter);

// ---------------------------------------------------------------------------
// QUERY BUILDER
// Safely build parameterized WHERE clause from filter object.
// Never interpolate user input directly into SQL — always use ? placeholders.
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
  // Full-text search across name + country_name
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

// Whitelist sortable columns to prevent SQL injection via sort param
const SORTABLE = ['name', 'age', 'gender', 'country_name', 'created_at', 'gender_probability'];

function getSortParams(sortBy, order) {
  const col = SORTABLE.includes(sortBy) ? sortBy : 'created_at';
  const dir = order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${col} ${dir}`;
}

// ---------------------------------------------------------------------------
// GET /api/profiles
// List profiles with filtering, sorting, pagination.
// Both admin and analyst can access.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const {
    gender, country_id, country_name, age_group,
    min_age, max_age, search,
    sort_by, order, page: pageQ, limit: limitQ,
  } = req.query;

  const filters = { gender, country_id, country_name, age_group, min_age, max_age, search };
  const { whereClause, params } = buildWhere(filters);

  const page = Math.max(1, parseInt(pageQ) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(limitQ) || 10));
  const offset = (page - 1) * limit;
  const orderClause = getSortParams(sort_by, order);

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM profiles ${whereClause}`
  ).get(...params).c;

  const profiles = db.prepare(
    `SELECT * FROM profiles ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  // Build query object for HATEOAS links (exclude page/limit — those are added by sendPaginated)
  const queryObj = {};
  if (gender) queryObj.gender = gender;
  if (country_id) queryObj.country_id = country_id;
  if (age_group) queryObj.age_group = age_group;
  if (search) queryObj.search = search;
  if (sort_by) queryObj.sort_by = sort_by;
  if (order) queryObj.order = order;

  return sendPaginated(res, {
    data: profiles,
    page,
    limit,
    total,
    basePath: '/api/profiles',
    query: queryObj,
  });
});

// ---------------------------------------------------------------------------
// GET /api/profiles/search
// Natural language search. Must be defined BEFORE /:id to avoid route conflict.
// TRD: Same response shape as GET /api/profiles.
// ---------------------------------------------------------------------------
router.get('/search', (req, res) => {
  const rawQuery = req.query.q || req.query.query || '';
  if (!rawQuery.trim()) {
    return sendError(res, 'Query parameter ?q is required', 400);
  }

  // Parse NL query into structured filters
  const nlFilters = parseNaturalLanguageQuery(rawQuery);
  // Only use raw text search if NL extracted no structured filters
  if (Object.keys(nlFilters).length === 0) {
    nlFilters.search = rawQuery;
  }

  const { whereClause, params } = buildWhere(nlFilters);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM profiles ${whereClause}`
  ).get(...params).c;

  const profiles = db.prepare(
    `SELECT * FROM profiles ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return sendPaginated(res, {
    data: profiles,
    page,
    limit,
    total,
    basePath: '/api/profiles/search',
    query: { q: rawQuery },
  });
});

// ---------------------------------------------------------------------------
// GET /api/profiles/export?format=csv
// TRD: Applies same filters as GET /api/profiles. Returns CSV file.
// CSV columns: id, name, gender, gender_probability, age, age_group,
//              country_id, country_name, country_probability, created_at
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
// GET /api/profiles/:id
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!profile) return sendError(res, 'Profile not found', 404);
  return sendSuccess(res, { data: profile });
});

// ---------------------------------------------------------------------------
// POST /api/profiles
// Admin only. TRD: accepts { name } → calls external APIs → stores → returns.
//
// External APIs used (from Stage 1):
//   Genderize.io   — gender + probability
//   Agify.io       — age + age_group
//   Nationalize.io — country + probability
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return sendError(res, 'name is required', 400);

  try {
    // Call all three external APIs concurrently for performance
    const [genderRes, ageRes, nationalityRes] = await Promise.allSettled([
      axios.get(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
      axios.get(`https://api.agify.io?name=${encodeURIComponent(name)}`),
      axios.get(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
    ]);

    // Extract data (use null if an API call failed)
    const genderData = genderRes.status === 'fulfilled' ? genderRes.value.data : {};
    const ageData = ageRes.status === 'fulfilled' ? ageRes.value.data : {};
    const nationalityData = nationalityRes.status === 'fulfilled' ? nationalityRes.value.data : {};

    // Compute age_group from age
    const age = ageData.age ?? null;
    let age_group = null;
    if (age !== null) {
      if (age < 18) age_group = 'young-adult';
      else if (age < 35) age_group = 'adult';
      else if (age < 55) age_group = 'middle-aged';
      else age_group = 'senior';
    }

    // Take the top nationality result
    const topNationality = nationalityData.country?.[0] ?? null;

    // Get country name from country_id (simple lookup)
    const COUNTRY_NAMES = {
      US: 'United States', GB: 'United Kingdom', NG: 'Nigeria', GH: 'Ghana',
      DE: 'Germany', FR: 'France', BR: 'Brazil', KR: 'South Korea',
      IN: 'India', CA: 'Canada', AU: 'Australia', ZA: 'South Africa',
      KE: 'Kenya', EG: 'Egypt', JP: 'Japan', CN: 'China',
    };

    const countryId = topNationality?.country_id ?? null;
    const countryName = countryId ? (COUNTRY_NAMES[countryId] ?? countryId) : null;

    // Save to DB
    const id = uuidv7();
    db.prepare(`
      INSERT INTO profiles
        (id, name, gender, gender_probability, age, age_group,
         country_id, country_name, country_probability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name.trim(),
      genderData.gender ?? null,
      genderData.probability ?? null,
      age,
      age_group,
      countryId,
      countryName,
      topNationality?.probability ?? null,
    );

    const created = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return sendSuccess(res, { data: created }, 201);
  } catch (err) {
    return sendError(res, `Failed to create profile: ${err.message}`, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/profiles/:id — admin only
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!profile) return sendError(res, 'Profile not found', 404);

  db.prepare('DELETE FROM profiles WHERE id = ?').run(req.params.id);
  return sendSuccess(res, { message: 'Profile deleted', id: req.params.id });
});

export default router;
