// src/middleware/auth.js
//
// Three middleware functions:
//
//   authenticate    — verifies Bearer JWT, attaches req.user
//   checkActive     — if user.is_active === false → 403 (TRD requirement)
//   requireRole     — factory: requireRole('admin') checks app role
//
// ALWAYS use in order: authenticate → checkActive → requireRole
// The checkActive step is a TRD-specific requirement: banned users get 403
// on every single request, even read-only ones.

import { verifyAccessToken } from '../utils/tokens.js';
import { sendError } from '../utils/response.js';
import db from '../config/database.js';

/**
 * authenticate
 * Reads Bearer token from Authorization header, verifies it,
 * loads fresh user from DB, attaches to req.user.
 */
export function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return sendError(res, 'Missing or malformed Authorization header', 401);
  }

  const token = header.slice(7);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 'Access token expired — call POST /auth/refresh', 401);
    }
    return sendError(res, 'Invalid access token', 401);
  }

  // Load user from DB — we always fetch fresh so role changes take effect immediately
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) {
    return sendError(res, 'User no longer exists', 401);
  }

  req.user = user;
  next();
}

/**
 * checkActive
 * TRD: "If is_active is false → 403 Forbidden on all requests"
 * Must run after authenticate.
 */
export function checkActive(req, res, next) {
  if (!req.user) return sendError(res, 'Not authenticated', 401);
  if (!req.user.is_active) {
    return sendError(res, 'Account is deactivated — contact an administrator', 403);
  }
  next();
}

/**
 * requireRole(...roles)
 * Factory that returns a middleware enforcing role membership.
 *
 * Usage:
 *   router.post('/profiles', authenticate, checkActive, requireRole('admin'), handler)
 *
 * @param {...string} roles — e.g. 'admin', 'analyst'
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 'Not authenticated', 401);
    if (!roles.includes(req.user.role)) {
      return sendError(
        res,
        `Insufficient permissions. Required: ${roles.join(' or ')}. Yours: ${req.user.role}`,
        403
      );
    }
    next();
  };
}

/**
 * Convenience: full auth chain (authenticate + checkActive)
 * Use this for all protected routes instead of listing both every time.
 */
export const protect = [authenticate, checkActive];
