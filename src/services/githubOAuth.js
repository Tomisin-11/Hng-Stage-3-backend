// src/services/githubOAuth.js
//
// Complete GitHub OAuth + PKCE implementation.
//
// PKCE FLOW:
//   CLI:  generates verifier+challenge locally, sends to backend via /auth/github?source=cli
//   Web:  backend generates verifier+challenge, stores state, redirects browser
//
//   After GitHub redirect:
//     Backend receives code + state
//     Looks up code_verifier from oauth_states table
//     Sends code + code_verifier to GitHub for token exchange
//     Fetches user profile from GitHub API
//     Creates or updates user in DB (default role: analyst)
//     Issues our own access + refresh tokens
//     Returns tokens (or sets cookie for web)

import axios from 'axios';
import db, { uuidv7 } from '../config/database.js';
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  createAccessToken, createRefreshToken, hashToken,
} from '../utils/tokens.js';

/**
 * STEP 1: Initiate OAuth flow.
 * Generates PKCE params, stores state in DB, returns GitHub auth URL.
 *
 * @param {'web'|'cli'} source
 * @param {string|null} externalVerifier — CLI provides its own verifier
 */
export function initiateOAuth(source = 'web', externalVerifier = null) {
  // For CLI: the CLI generates the verifier locally and sends it here.
  // For Web: we generate it server-side.
  const verifier = externalVerifier || generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  const redirectUri = source === 'cli'
    ? process.env.GITHUB_REDIRECT_URI_CLI
    : process.env.GITHUB_REDIRECT_URI_WEB;

  // Store state + verifier. Expires in 10 minutes.
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO oauth_states (state, code_verifier, source, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(state, verifier, source, expiresAt);

  const params = new URLSearchParams({
    client_id: source === 'cli'
      ? (process.env.GITHUB_CLI_CLIENT_ID || process.env.GITHUB_CLIENT_ID)
      : process.env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
    // GitHub partially supports PKCE — we send these for standards compliance
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `https://github.com/login/oauth/authorize?${params}`,
    state,
  };
}

/**
 * STEP 2: Handle OAuth callback.
 * Validates state, exchanges code for GitHub token, fetches user, issues our tokens.
 *
 * @returns {{ accessToken, refreshToken, user, expiresIn }}
 */
export async function handleCallback(code, state) {
  // Retrieve and validate state
  const stored = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (!stored) throw new Error('Invalid OAuth state — possible CSRF attack');
  if (new Date(stored.expires_at) < new Date()) {
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    throw new Error('OAuth state expired — please restart the login flow');
  }

  // Delete state immediately (one-time use)
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  const redirectUri = stored.source === 'cli'
    ? process.env.GITHUB_REDIRECT_URI_CLI
    : process.env.GITHUB_REDIRECT_URI_WEB;

  // Exchange authorization code for GitHub access token
  // Use the correct OAuth App credentials based on source (web vs CLI)
  const clientId = stored.source === 'cli'
    ? (process.env.GITHUB_CLI_CLIENT_ID || process.env.GITHUB_CLIENT_ID)
    : process.env.GITHUB_CLIENT_ID;
  const clientSecret = stored.source === 'cli'
    ? (process.env.GITHUB_CLI_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET)
    : process.env.GITHUB_CLIENT_SECRET;

  let githubAccessToken;
  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: stored.code_verifier,
      },
      { headers: { Accept: 'application/json' } }
    );
    githubAccessToken = tokenRes.data.access_token;
    if (!githubAccessToken) {
      throw new Error(tokenRes.data.error_description || 'No access token in response');
    }
  } catch (err) {
    throw new Error(`GitHub token exchange failed: ${err.message}`);
  }

  // Fetch GitHub user profile + emails
  const [profileRes, emailsRes] = await Promise.all([
    axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubAccessToken}` },
    }),
    axios.get('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${githubAccessToken}` },
    }),
  ]);

  const ghUser = profileRes.data;
  const primaryEmail = emailsRes.data.find(e => e.primary && e.verified)?.email
    ?? emailsRes.data[0]?.email ?? null;

  // Upsert user in our DB
  const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(ghUser.id));

  let user;
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE users
      SET username = ?, email = ?, avatar_url = ?, last_login_at = ?
      WHERE github_id = ?
    `).run(ghUser.login, primaryEmail, ghUser.avatar_url, now, String(ghUser.id));
    user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(ghUser.id));
  } else {
    const newId = uuidv7();
    db.prepare(`
      INSERT INTO users (id, github_id, username, email, avatar_url, role, last_login_at)
      VALUES (?, ?, ?, ?, ?, 'analyst', ?)
    `).run(newId, String(ghUser.id), ghUser.login, primaryEmail, ghUser.avatar_url, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
  }

  // Issue our tokens
  const accessToken = createAccessToken(user);
  const refreshToken = createRefreshToken(user);
  const expiresIn = parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 180; // 3 min

  // Persist refresh token hash
  const tokenExpiry = new Date(
    Date.now() + (parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 300) * 1000
  ).toISOString();

  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uuidv7(), user.id, hashToken(refreshToken), tokenExpiry);

  return { accessToken, refreshToken, user, expiresIn };
}
