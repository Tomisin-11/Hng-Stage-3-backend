// src/services/queryNormalizer.js
//
// Normalizes parsed filter objects into a canonical (standard) form so that
// semantically equivalent queries always produce the same cache key.
//
// Problem it solves:
//   "Nigerian females aged 20-45" and "Women aged 20–45 living in Nigeria"
//   both parse to the same logical filter, but without normalization they
//   may differ in key casing, key order, or numeric type, producing
//   different JSON strings — and different cache keys — causing redundant
//   DB queries.
//
// Rules applied:
//   1. String values → lowercased and trimmed
//   2. country_id → uppercased (ISO codes are uppercase by convention)
//   3. Numeric values (min_age, max_age) → parsed to integers
//   4. Keys sorted alphabetically → deterministic JSON key order
//   5. Null / undefined / empty-string values → dropped entirely
//
// Constraints:
//   - Deterministic: same input → always same output
//   - No AI or external calls
//   - Does not alter intent: we only normalize form, not meaning

/**
 * Normalize a raw filter object into canonical form.
 *
 * @param {object} filters  Raw filters from query params or NLP parser
 * @returns {object}        Normalized filter object, sorted keys, clean values
 */
export function normalizeFilters(filters) {
  const norm = {};

  // gender: "Male" | "FEMALE" | "male" → "male" / "female"
  if (filters.gender != null && filters.gender !== '') {
    norm.gender = String(filters.gender).toLowerCase().trim();
  }

  // country_id: ISO codes → always uppercase ("ng" → "NG")
  if (filters.country_id != null && filters.country_id !== '') {
    norm.country_id = String(filters.country_id).toUpperCase().trim();
  }

  // country_name: free-text → lowercase for case-insensitive comparison
  if (filters.country_name != null && filters.country_name !== '') {
    norm.country_name = String(filters.country_name).toLowerCase().trim();
  }

  // age_group: "Young-Adult" | "ADULT" → "young-adult" / "adult"
  if (filters.age_group != null && filters.age_group !== '') {
    norm.age_group = String(filters.age_group).toLowerCase().trim();
  }

  // min_age / max_age: must be integers (parseFloat input safe via parseInt)
  if (filters.min_age != null && filters.min_age !== '') {
    const v = parseInt(filters.min_age, 10);
    if (!isNaN(v)) norm.min_age = v;
  }
  if (filters.max_age != null && filters.max_age !== '') {
    const v = parseInt(filters.max_age, 10);
    if (!isNaN(v)) norm.max_age = v;
  }

  // search: free-text → lowercase for consistent matching
  if (filters.search != null && filters.search !== '') {
    norm.search = String(filters.search).toLowerCase().trim();
  }

  // Sort keys alphabetically so key order never affects the cache key.
  // JSON.stringify preserves insertion order, so without sorting:
  //   { gender: 'female', country_id: 'NG' } → different string than
  //   { country_id: 'NG', gender: 'female' }
  return Object.fromEntries(
    Object.entries(norm).sort(([a], [b]) => a.localeCompare(b))
  );
}

/**
 * Produce a deterministic cache key for a full query (filters + pagination + sort).
 *
 * @param {object} normalizedFilters  Output of normalizeFilters()
 * @param {number} page
 * @param {number} limit
 * @param {string} sortBy
 * @param {string} order
 * @returns {string}
 */
export function makeCacheKey(normalizedFilters, page, limit, sortBy, order) {
  return JSON.stringify({
    f: normalizedFilters,
    p: page,
    l: limit,
    s: sortBy || 'created_at',
    o: (order || 'desc').toLowerCase(),
  });
}
