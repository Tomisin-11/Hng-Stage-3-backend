# Insighta Labs+ — Backend

> Stage 3 Backend: Secure access, GitHub OAuth with PKCE, RBAC, API versioning

## System Architecture

```
insighta-backend/
├── src/
│   ├── config/
│   │   └── database.js        # SQLite schema (UUID v7 PKs, WAL mode)
│   ├── middleware/
│   │   ├── auth.js            # authenticate, checkActive, requireRole
│   │   ├── apiVersion.js      # Enforces X-API-Version: 1 header
│   │   ├── rateLimiter.js     # 10/min auth, 60/min API per user
│   │   └── requestLogger.js   # Logs method, endpoint, status, response time
│   ├── routes/
│   │   ├── auth.js            # /auth/* endpoints
│   │   ├── profiles.js        # /api/profiles/* endpoints
│   │   └── users.js           # /api/users/* endpoints (admin)
│   ├── services/
│   │   ├── githubOAuth.js     # PKCE flow, token exchange, user upsert
│   │   └── nlpSearch.js       # Natural language → structured filters
│   ├── utils/
│   │   ├── tokens.js          # JWT create/verify, PKCE helpers, hashing
│   │   └── response.js        # Standardized { status, data } response shapes
│   └── index.js               # Express app, middleware stack, router mounting
```

## Authentication Flow

### GitHub OAuth with PKCE

**Web Portal flow:**
1. Frontend calls `GET /auth/github?source=web`
2. Backend generates `code_verifier`, `code_challenge`, `state` → stores in DB
3. Returns GitHub authorization URL
4. Browser follows URL → user approves on GitHub
5. GitHub redirects to `/auth/github/callback?code=X&state=Y`
6. Backend: verifies state, exchanges code + verifier for GitHub token
7. Fetches GitHub user profile, upserts user (default role: `analyst`)
8. Issues our own access token (3 min) + refresh token (5 min)
9. Sets **HTTP-only cookie** for refresh token, returns access token in body

**CLI flow:**
1. CLI generates its own `code_verifier` + `code_challenge`
2. Calls `GET /auth/github?source=cli&code_verifier=<verifier>`
3. Backend stores verifier, returns auth URL
4. CLI opens URL in browser, spins up local server on `localhost:9876`
5. GitHub redirects to `localhost:9876/callback`
6. CLI captures code + state, forwards to `GET /auth/github/callback?code=X&state=Y&src=cli`
7. Backend returns **both tokens in JSON body** (no cookie for CLI)
8. CLI saves to `~/.insighta/credentials.json`

### Token Expiry (per TRD)
| Token | Expiry |
|-------|--------|
| Access token | **3 minutes** |
| Refresh token | **5 minutes** |

### Token Rotation
Every refresh call:
1. Validates the old refresh token (JWT + DB lookup by SHA-256 hash)
2. **Immediately revokes** the old token
3. Issues a new access + refresh token pair
4. If an already-revoked token is presented → all user tokens revoked (theft detection)

## CLI Usage

```bash
# Install globally
npm install -g .

insighta login                              # GitHub OAuth
insighta logout
insighta whoami

insighta profiles list
insighta profiles list --gender male
insighta profiles list --country NG --age-group adult
insighta profiles list --min-age 25 --max-age 40
insighta profiles list --sort-by age --order desc
insighta profiles list --page 2 --limit 20

insighta profiles get <id>
insighta profiles search "young males from nigeria"
insighta profiles create --name "Harriet Tubman"
insighta profiles export --format csv
insighta profiles export --format csv --gender male --country NG
```

## Token Handling Approach

**Access tokens:**
- Short-lived JWT (3 min), signed with `ACCESS_TOKEN_SECRET`
- Payload: `{ sub: userId, role }`
- Sent as `Authorization: Bearer <token>` on every API request
- Web: stored **in memory** only (never localStorage — XSS protection)
- CLI: stored in `~/.insighta/credentials.json` with `chmod 600`

**Refresh tokens:**
- Longer-lived JWT (5 min), signed with `REFRESH_TOKEN_SECRET`
- Web: stored in **HTTP-only, SameSite=Strict, path=/auth cookie** — JS cannot read it
- CLI: stored in `~/.insighta/credentials.json`
- Database: only the **SHA-256 hash** is stored, never the raw token
- Token rotation: each refresh invalidates the old token and issues a new pair

## Role Enforcement Logic

Two roles: `admin` and `analyst` (default).

```
authenticate → checkActive → requireRole('admin')
```

1. **`authenticate`**: Verifies Bearer JWT, loads fresh user from DB
2. **`checkActive`**: If `is_active = 0` → 403 on ALL requests (TRD requirement)
3. **`requireRole`**: Checks `user.role` against allowed roles

| Operation | admin | analyst |
|-----------|-------|---------|
| GET /api/profiles | ✓ | ✓ |
| GET /api/profiles/search | ✓ | ✓ |
| GET /api/profiles/export | ✓ | ✓ |
| POST /api/profiles | ✓ | ✗ |
| DELETE /api/profiles/:id | ✓ | ✗ |
| GET /api/users | ✓ | ✗ |
| PATCH /api/users/:id/role | ✓ | ✗ |

## Natural Language Parsing Approach

Rule-based extraction using regex patterns over the profile data shape (gender, age, country).

**Extracted fields:**
- `gender` — male/female keywords (`male`, `man`, `men`, `female`, `woman`, `women`)
- `country_id` — ISO code lookup table (50+ country names/demonyms)
- `age_group` — keyword mapping (`young` → `young-adult`, `adult`, `middle-aged`, `senior`)
- `min_age` / `max_age` — patterns: `aged 25 to 35`, `older than 30`, `under 25`

**Examples:**
```
"young males from Nigeria"    → { gender: 'male', country_id: 'NG', age_group: 'young-adult' }
"women aged 25 to 40"         → { gender: 'female', min_age: 25, max_age: 40 }
"adult people from Germany"   → { age_group: 'adult', country_id: 'DE' }
```

## API Versioning

All `/api/*` endpoints require the header:
```
X-API-Version: 1
```

Missing or invalid version → `400 Bad Request`:
```json
{ "status": "error", "message": "API version header required" }
```

## Pagination Response Shape

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 42,
  "total_pages": 5,
  "links": {
    "self": "/api/profiles?page=1&limit=10",
    "next": "/api/profiles?page=2&limit=10",
    "prev": null
  },
  "data": [...]
}
```

## Rate Limiting

| Scope | Limit |
|-------|-------|
| `/auth/*` | 10 requests / minute per IP |
| `/api/*` | 60 requests / minute per user ID |

Exceeded → `429 Too Many Requests` with `retry_after_seconds`

## Logging

Every request logs: method, endpoint, status code, response time (ms), user ID, IP.

Stored in `request_logs` table (queryable). Also printed to stdout with color coding.

## Setup

```bash
git clone <repo>
cd insighta-backend
npm install
cp .env.example .env
# Edit .env with your GitHub OAuth credentials and JWT secrets
npm run dev
```

**Create GitHub OAuth App:**
1. Go to https://github.com/settings/developers → OAuth Apps → New
2. Homepage URL: `http://localhost:3000`
3. Callback URL: `http://localhost:3000/auth/callback` (web) + `http://localhost:9876/callback` (CLI)
4. Copy Client ID and Client Secret to `.env`

## Environment Variables

See `.env.example` for full documentation.

Key variables:
```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI_WEB=http://localhost:3000/auth/callback
GITHUB_REDIRECT_URI_CLI=http://localhost:9876/callback
ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=
ACCESS_TOKEN_EXPIRY=180    # 3 minutes
REFRESH_TOKEN_EXPIRY=300   # 5 minutes
PORT=4000
```
