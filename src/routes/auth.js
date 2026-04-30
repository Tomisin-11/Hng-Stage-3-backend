// src/routes/auth.js
//
// Authentication endpoints matching TRD spec:
//
//   GET  /auth/github          — redirect to GitHub OAuth
//   GET  /auth/github/callback — handle OAuth callback
//   POST /auth/refresh         — exchange refresh token (rotation)
//   POST /auth/logout          — revoke refresh token
//
// Token Expiry (TRD):
//   Access token:  3 minutes
//   Refresh token: 5 minutes
//
// Web: refresh token in HTTP-only cookie
// CLI: both tokens in JSON response body

import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimiter.js';
import { protect } from '../middleware/auth.js';
import { initiateOAuth, handleCallback } from '../services/githubOAuth.js';
import { verifyRefreshToken, createAccessToken, createRefreshToken, hashToken } from '../utils/tokens.js';
import { sendSuccess, sendError } from '../utils/response.js';
import db, { uuidv7 } from '../config/database.js';

const router = Router();
router.use(authLimiter);

// ---------------------------------------------------------------------------
// GET /auth/github
// Starts the OAuth flow. Returns the GitHub auth URL.
// ?source=cli|web  (default: web)
// ?code_verifier=...  (CLI provides its own PKCE verifier)
// ---------------------------------------------------------------------------
router.get('/github', (req, res) => {
  const source = req.query.source === 'cli' ? 'cli' : 'web';
  // CLI sends its own code_verifier; web lets server generate one
  const externalVerifier = req.query.code_verifier || null;

  try {
    const { url, state } = initiateOAuth(source, externalVerifier);
    return sendSuccess(res, { url, state });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/github/callback
// GitHub redirects here after user approves (or denies) access.
// ?code=... &state=... &src=cli (CLI adds this flag)
// ---------------------------------------------------------------------------
router.get('/github/callback', async (req, res) => {
  const { code, state, error, src } = req.query;

  if (error) return sendError(res, `GitHub OAuth denied: ${error}`, 400);
  if (!code || !state) return sendError(res, 'Missing code or state parameter', 400);

  try {
    const { accessToken, refreshToken, user, expiresIn } = await handleCallback(code, state);

    const userPayload = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_url,
      role: user.role,
    };

    if (src === 'cli') {
      // CLI: return both tokens in JSON body
      return sendSuccess(res, {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        user: userPayload,
      });
    }

    // Web: set HTTP-only cookie + redirect browser back to React app.
    // SameSite=lax allows the cookie to survive the redirect from GitHub.
    // We pass the access_token in the URL so React can pick it up,
    // store it in memory, then strip it from the address bar.
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: (parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 300) * 1000,
      path: '/',
    });

    const webAppBase = process.env.WEB_APP_URL || 'http://localhost:3000';
    const params = new URLSearchParams({ access_token: accessToken, expires_in: String(expiresIn) });
    return res.redirect(`${webAppBase}/auth/callback?${params}`);
  } catch (err) {
    return sendError(res, err.message, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// TRD spec:
//   Request:  { "refresh_token": "string" }  (or HTTP-only cookie for web)
//   Response: { "status": "success", "access_token": "...", "refresh_token": "..." }
//
// Old refresh token is IMMEDIATELY INVALIDATED after use (rotation).
// If an already-used token is presented → revoke ALL user tokens (theft detection).
// ---------------------------------------------------------------------------
router.post('/refresh', (req, res) => {
  // Web uses cookie; CLI sends in body
  const token = req.cookies?.refresh_token || req.body?.refresh_token;
  if (!token) return sendError(res, 'No refresh token provided', 401);

  // Verify JWT
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    return sendError(res, 'Invalid or expired refresh token', 401);
  }

  // Look up hash in DB
  const stored = db.prepare(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0'
  ).get(hashToken(token));

  if (!stored) {
    // Token reuse detected — revoke ALL tokens for this user
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(payload.sub);
    return sendError(res, 'Refresh token already used or revoked (possible theft detected)', 401);
  }

  // Revoke old token (rotation)
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(stored.id);

  // Load user
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return sendError(res, 'User not found', 401);
  if (!user.is_active) return sendError(res, 'Account deactivated', 403);

  // Issue new token pair
  const newAccess = createAccessToken(user);
  const newRefresh = createRefreshToken(user);
  const expiresIn = parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 180;

  const tokenExpiry = new Date(
    Date.now() + (parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 300) * 1000
  ).toISOString();

  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uuidv7(), user.id, hashToken(newRefresh), tokenExpiry);

  // Update cookie for web clients
  if (req.cookies?.refresh_token) {
    res.cookie('refresh_token', newRefresh, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: (parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 300) * 1000,
      path: '/auth',
    });
  }

  return sendSuccess(res, {
    access_token: newAccess,
    // Only include refresh_token in body for CLI (not web — web uses cookie)
    ...(req.cookies?.refresh_token ? {} : { refresh_token: newRefresh }),
    expires_in: expiresIn,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// TRD: invalidates the refresh token server-side
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  const token = req.cookies?.refresh_token || req.body?.refresh_token;
  if (token) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?')
      .run(hashToken(token));
  }
  res.clearCookie('refresh_token', { path: '/auth' });
  return sendSuccess(res, { message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------------
// GET /auth/me — current user info (protected)
// ---------------------------------------------------------------------------
router.get('/me', ...protect, (req, res) => {
  const u = req.user;
  return sendSuccess(res, {
    data: {
      id: u.id,
      username: u.username,
      email: u.email,
      avatar_url: u.avatar_url,
      role: u.role,
      is_active: !!u.is_active,
      last_login_at: u.last_login_at,
      created_at: u.created_at,
    },
  });
});

export default router;
