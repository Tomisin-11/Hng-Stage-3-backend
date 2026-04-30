// src/utils/tokens.js
//
// JWT and cryptographic token helpers.
//
// TRD SPECIFIED EXPIRY:
//   Access token:  3 minutes (180 seconds)
//   Refresh token: 5 minutes (300 seconds)
//
// These are intentionally short for security. The CLI and web portal
// must handle auto-refresh transparently.

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// ACCESS TOKEN — 3 minutes
// Payload: { sub: userId, role, iat, exp }
// ---------------------------------------------------------------------------

export function createAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 180, issuer: 'insighta' }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { issuer: 'insighta' });
}

// ---------------------------------------------------------------------------
// REFRESH TOKEN — 5 minutes
// Payload: { sub: userId, iat, exp }
// ---------------------------------------------------------------------------

export function createRefreshToken(user) {
  return jwt.sign(
    { sub: user.id },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 300, issuer: 'insighta' }
  );
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.REFRESH_TOKEN_SECRET, { issuer: 'insighta' });
}

// ---------------------------------------------------------------------------
// HASHING
// Store SHA-256 hash of refresh tokens — raw token never hits the DB.
// ---------------------------------------------------------------------------

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// PKCE HELPERS (RFC 7636)
//
// PKCE prevents authorization code interception.
//   1. Client generates random code_verifier
//   2. Derives code_challenge = BASE64URL(SHA256(verifier))
//   3. Sends code_challenge to auth server (GitHub)
//   4. When exchanging code → sends code_verifier to prove identity
// ---------------------------------------------------------------------------

export function generateCodeVerifier() {
  // 32 random bytes = 64 hex chars, within the 43-128 char PKCE range
  return crypto.randomBytes(32).toString('hex');
}

export function generateCodeChallenge(verifier) {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')  // base64url encoding
    .replace(/\//g, '_')
    .replace(/=/g, '');   // no padding
}

export function generateState() {
  return crypto.randomBytes(16).toString('hex');
}
