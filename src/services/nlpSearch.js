// src/services/nlpSearch.js
//
// Natural language → structured filter extraction.
//
// Profiles in Stage 3 use the external API shape:
//   gender, age, age_group, country_id, country_name
//
// Supported query patterns:
//   "young males from Nigeria"     → { gender: 'male', country_id: 'NG', age_group: 'young-adult' }
//   "adult females"                → { gender: 'female', age_group: 'adult' }
//   "people from Germany"         → { country_name: 'Germany' }
//   "males older than 30"         → { gender: 'male', min_age: 30 }
//   "women aged 25 to 35"         → { gender: 'female', min_age: 25, max_age: 35 }

const COUNTRY_MAP = {
  nigeria: 'NG', nigerian: 'NG',
  ghana: 'GH', ghanaian: 'GH',
  kenya: 'KE', kenyan: 'KE',
  'south africa': 'ZA',
  germany: 'DE', german: 'DE',
  france: 'FR', french: 'FR',
  uk: 'GB', 'united kingdom': 'GB', british: 'GB', england: 'GB',
  us: 'US', usa: 'US', 'united states': 'US', american: 'US',
  brazil: 'BR', brazilian: 'BR',
  'south korea': 'KR', korean: 'KR',
  india: 'IN', indian: 'IN',
  canada: 'CA', canadian: 'CA',
};

const AGE_GROUP_MAP = {
  young: 'young-adult', 'young adult': 'young-adult', youth: 'young-adult', teens: 'young-adult',
  adult: 'adult', adults: 'adult',
  'middle aged': 'middle-aged', 'middle-aged': 'middle-aged', middle: 'middle-aged',
  senior: 'senior', old: 'senior', elderly: 'senior',
};

/**
 * Parse a natural language query into filter params for the DB query builder.
 * @param {string} query
 * @returns {{ gender?, country_id?, country_name?, age_group?, min_age?, max_age? }}
 */
export function parseNaturalLanguageQuery(query) {
  if (!query?.trim()) return {};

  const q = query.toLowerCase().trim();
  const filters = {};

  // ── Gender ── (covers plural forms: males, boys, girls, etc.)
  if (/\b(males?|man|men|boys?|guys?|masculine)\b/.test(q)) {
    filters.gender = 'male';
  } else if (/\b(females?|woman|women|girls?|lady|ladies|feminine)\b/.test(q)) {
    filters.gender = 'female';
  }

  // ── Country ── (check multi-word first, then single-word)
  let foundCountry = false;
  const sortedCountries = Object.keys(COUNTRY_MAP).sort((a, b) => b.length - a.length);
  for (const country of sortedCountries) {
    if (q.includes(country)) {
      filters.country_id = COUNTRY_MAP[country];
      foundCountry = true;
      break;
    }
  }
  // If no ISO match, try extracting "from <Country>" as country_name
  if (!foundCountry) {
    const fromMatch = query.match(/\bfrom\s+([A-Z][a-zA-Z\s]{2,20}?)(?:\s+(?:who|that|and|,)|$)/);
    if (fromMatch) {
      filters.country_name = fromMatch[1].trim();
    }
  }

  // ── Age Group ──
  const sortedGroups = Object.keys(AGE_GROUP_MAP).sort((a, b) => b.length - a.length);
  for (const key of sortedGroups) {
    if (q.includes(key)) {
      filters.age_group = AGE_GROUP_MAP[key];
      break;
    }
  }

  // ── Age Range ──
  // "aged 25 to 35" | "age 25-35" | "between 25 and 35"
  const rangeMatch = q.match(/\baged?\s+(\d+)\s+(?:to|and|-)\s+(\d+)\b/)
    || q.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/);
  if (rangeMatch) {
    filters.min_age = parseInt(rangeMatch[1]);
    filters.max_age = parseInt(rangeMatch[2]);
  }

  // "older than 30" | "above 30" | "over 30"
  const minMatch = q.match(/\b(?:older than|above|over|at least)\s+(\d+)\b/);
  if (minMatch) filters.min_age = parseInt(minMatch[1]);

  // "younger than 25" | "under 25" | "below 25"
  const maxMatch = q.match(/\b(?:younger than|under|below|at most)\s+(\d+)\b/);
  if (maxMatch) filters.max_age = parseInt(maxMatch[1]);

  // Specific age: "aged 28"
  if (!rangeMatch && !minMatch && !maxMatch) {
    const exactAge = q.match(/\baged?\s+(\d+)\b/);
    if (exactAge) {
      filters.min_age = parseInt(exactAge[1]);
      filters.max_age = parseInt(exactAge[1]);
    }
  }

  // ── Clear contradictory filters ──
  if (filters.min_age !== undefined && filters.max_age !== undefined
      && filters.min_age > filters.max_age) {
    delete filters.min_age;
    delete filters.max_age;
  }

  return filters;
}
