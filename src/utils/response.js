// src/utils/response.js
//
// Standardized response formatters.
//
// TRD requires ALL responses to use consistent shape:
//   Success: { status: 'success', data: {...} }
//   Error:   { status: 'error', message: '...' }
//
// Using helpers ensures no endpoint accidentally returns bare objects.

/**
 * Send a success response.
 * @param {Response} res - Express response object
 * @param {any} data - payload to send
 * @param {number} statusCode - HTTP status (default 200)
 */
export function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ status: 'success', ...data });
}

/**
 * Send an error response.
 * @param {Response} res
 * @param {string} message - human-readable error description
 * @param {number} statusCode - HTTP status (default 400)
 */
export function sendError(res, message, statusCode = 400) {
  return res.status(statusCode).json({ status: 'error', message });
}

/**
 * Build TRD-spec pagination response with HATEOAS links.
 *
 * TRD required shape:
 * {
 *   status: 'success',
 *   page, limit, total, total_pages,
 *   links: { self, next, prev },
 *   data: [...]
 * }
 */
export function sendPaginated(res, { data, page, limit, total, basePath, query = {} }) {
  const total_pages = Math.ceil(total / limit);
  const hasNext = page < total_pages;
  const hasPrev = page > 1;

  // Build query string helper
  const qs = (p) => {
    const params = new URLSearchParams({ ...query, page: p, limit });
    return `${basePath}?${params}`;
  };

  return res.status(200).json({
    status: 'success',
    page,
    limit,
    total,
    total_pages,
    links: {
      self: qs(page),
      next: hasNext ? qs(page + 1) : null,
      prev: hasPrev ? qs(page - 1) : null,
    },
    data,
  });
}
