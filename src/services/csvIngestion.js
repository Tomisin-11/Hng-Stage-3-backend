// src/services/csvIngestion.js
//
// Streams a large CSV file (up to 500k rows) and bulk-inserts valid rows
// into the profiles table without loading the whole file into memory.
//
// Design decisions:
//
//   STREAMING not loading:
//     We use Node's readline interface to read the file line by line.
//     At no point is the entire file buffered in memory.
//
//   BATCHED TRANSACTIONS not row-by-row:
//     Individual INSERTs in SQLite are slow because each is a separate
//     disk fsync. Wrapping 1000 rows in a single transaction makes bulk
//     inserts ~100x faster in SQLite (WAL mode).
//
//   EVENT LOOP YIELD between batches:
//     After each batch we call setImmediate() to yield, allowing Express
//     to handle incoming read queries before the next batch starts.
//     This keeps query latency acceptable during concurrent uploads.
//
//   NO ROLLBACK on partial failure:
//     Per spec: "rows already inserted must remain". We commit each batch
//     independently. A failure mid-file leaves all previously inserted
//     rows in place.
//
//   DUPLICATE CHECK via name uniqueness:
//     POST /api/profiles enforces name uniqueness. We apply the same rule
//     here by querying for existing names before inserting each batch.
//     We check in bulk (one query per batch) to avoid N+1 lookups.
//
// Expected CSV columns (header row required):
//   name, gender, age, country_id
//   Optional: country_name, gender_probability, country_probability
//
// Validation rules (skip row if any fail):
//   - name present and non-empty
//   - gender is 'male' or 'female' (case-insensitive)
//   - age is a positive integer (1–120)
//   - country_id present and 2-letter ISO code
//   - row column count matches header count
//   - name does not already exist in the database

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { uuidv7 } from '../config/database.js';
import db from '../config/database.js';
import { queryCache } from './queryCache.js';

const BATCH_SIZE = 1000; // Rows per SQLite transaction

const VALID_GENDERS = new Set(['male', 'female']);

/**
 * Derive age_group from numeric age (mirrors POST /api/profiles logic).
 */
function deriveAgeGroup(age) {
  if (age < 18) return 'young-adult';
  if (age < 35) return 'adult';
  if (age < 55) return 'middle-aged';
  return 'senior';
}

/**
 * Parse a single CSV line into fields, handling quoted values.
 * Handles: "field with, comma", escaped quotes (""), embedded newlines not supported.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'; // Escaped quote
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Validate a parsed row object.
 * Returns { valid: true, data: {...} } or { valid: false, reason: string }
 */
function validateRow(row) {
  // name
  if (!row.name || row.name.trim() === '') {
    return { valid: false, reason: 'missing_fields' };
  }

  // gender
  const gender = row.gender?.toLowerCase().trim();
  if (!VALID_GENDERS.has(gender)) {
    return { valid: false, reason: 'invalid_gender' };
  }

  // age
  const age = parseInt(row.age, 10);
  if (isNaN(age) || age <= 0 || age > 120) {
    return { valid: false, reason: 'invalid_age' };
  }

  // country_id
  const country_id = row.country_id?.trim().toUpperCase();
  if (!country_id || country_id.length !== 2) {
    return { valid: false, reason: 'missing_fields' };
  }

  return {
    valid: true,
    data: {
      id: uuidv7(),
      name: row.name.trim(),
      gender,
      gender_probability: parseFloat(row.gender_probability) || null,
      age,
      age_group: deriveAgeGroup(age),
      country_id,
      country_name: row.country_name?.trim() || null,
      country_probability: parseFloat(row.country_probability) || null,
    },
  };
}

/**
 * Insert a batch of valid rows. Checks for duplicate names within the DB
 * before inserting, then wraps inserts in a single transaction.
 *
 * @param {Array<object>} batch   Valid, pre-validated row objects
 * @param {object}        stats   Mutable stats object to update
 */
function insertBatch(batch, stats) {
  if (batch.length === 0) return;

  // Bulk duplicate-name check: one query for the whole batch
  // Build: WHERE name IN (?, ?, ...)
  const names = batch.map(r => r.name);
  const placeholders = names.map(() => '?').join(', ');
  const existingNames = new Set(
    db.prepare(`SELECT name FROM profiles WHERE name IN (${placeholders})`)
      .all(...names)
      .map(r => r.name.toLowerCase())
  );

  const toInsert = [];
  for (const row of batch) {
    if (existingNames.has(row.name.toLowerCase())) {
      stats.skipped++;
      stats.reasons.duplicate_name = (stats.reasons.duplicate_name || 0) + 1;
    } else {
      toInsert.push(row);
    }
  }

  if (toInsert.length === 0) return;

  // Single transaction for the whole batch — this is the key perf win
  const insert = db.prepare(`
    INSERT INTO profiles
      (id, name, gender, gender_probability, age, age_group,
       country_id, country_name, country_probability)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Use exec for transaction wrapping (node:sqlite compatible)
  db.exec('BEGIN');
  try {
    for (const row of toInsert) {
      insert.run(
        row.id, row.name, row.gender, row.gender_probability,
        row.age, row.age_group, row.country_id, row.country_name,
        row.country_probability,
      );
    }
    db.exec('COMMIT');
    stats.inserted += toInsert.length;
  } catch (err) {
    db.exec('ROLLBACK');
    // Don't throw — partial failures are expected. Log and continue.
    console.error('[csvIngestion] Batch insert failed, rolling back batch:', err.message);
    stats.skipped += toInsert.length;
    stats.reasons.insert_error = (stats.reasons.insert_error || 0) + toInsert.length;
  }
}

/**
 * Process a CSV file at the given path.
 * Streams line by line, validates each row, inserts in batches.
 *
 * @param {string} filePath   Absolute path to the uploaded CSV file
 * @returns {Promise<object>} { total_rows, inserted, skipped, reasons }
 */
export async function processCSV(filePath) {
  const stats = {
    total_rows: 0,  // Excludes header row
    inserted: 0,
    skipped: 0,
    reasons: {},
  };

  let headerFields = null;
  let batch = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity, // Handle \r\n line endings
  });

  // Process line-by-line using async iteration (no buffering)
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue; // Skip blank lines

    const fields = parseCsvLine(trimmed);

    // First non-empty line is the header
    if (!headerFields) {
      headerFields = fields.map(f => f.toLowerCase().trim());
      continue;
    }

    stats.total_rows++;

    // Malformed: wrong column count
    if (fields.length !== headerFields.length) {
      stats.skipped++;
      stats.reasons.malformed_row = (stats.reasons.malformed_row || 0) + 1;
      continue;
    }

    // Map fields to named object using header
    const row = {};
    for (let i = 0; i < headerFields.length; i++) {
      row[headerFields[i]] = fields[i];
    }

    // Validate
    const result = validateRow(row);
    if (!result.valid) {
      stats.skipped++;
      stats.reasons[result.reason] = (stats.reasons[result.reason] || 0) + 1;
      continue;
    }

    batch.push(result.data);

    // When batch is full, insert and yield to event loop
    if (batch.length >= BATCH_SIZE) {
      insertBatch(batch, stats);
      batch = [];

      // Yield to the event loop so incoming read queries can be served
      // between batches. This is the key mechanism preventing upload
      // operations from blocking query traffic.
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  // Insert any remaining rows in the last partial batch
  if (batch.length > 0) {
    insertBatch(batch, stats);
  }

  // Invalidate the query cache — new data means cached results are stale
  queryCache.invalidate();

  return stats;
}
