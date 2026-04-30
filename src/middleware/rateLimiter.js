// src/middleware/rateLimiter.js
//
// TRD Rate Limits:
//   Auth endpoints (/auth/*): 10 requests / minute
//   All other endpoints:      60 requests / minute per user
//
// "Per user" means: once authenticated, rate limit is keyed by user ID
// (not IP). This prevents shared-IP false positives in office environments.
// For unauthenticated requests (like /auth/*), we fall back to IP.

import rateLimit from 'express-rate-limit';
import { sendError } from '../utils/response.js';

const handler = (req, res) => {
  return res.status(429).json({
    status: 'error',
    message: 'Too many requests — please slow down',
    retry_after_seconds: Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000),
  });
};

// ---------------------------------------------------------------------------
// AUTH LIMITER — 10 requests per minute per IP
// Applied to /auth/* routes. Tight limit prevents brute-force on OAuth.
// ---------------------------------------------------------------------------
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  // Key by IP for auth routes (user not yet identified)
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] ?? req.ip,
});

// ---------------------------------------------------------------------------
// API LIMITER — 60 requests per minute per authenticated user
// Applied to /api/* routes. Key by user ID when available, fall back to IP.
// ---------------------------------------------------------------------------
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  keyGenerator: (req) => {
    // req.user is attached by authenticate middleware
    // For the apiLimiter, authenticate runs first, so req.user should exist
    return req.user?.id ?? req.headers['x-forwarded-for']?.split(',')[0] ?? req.ip;
  },
});
