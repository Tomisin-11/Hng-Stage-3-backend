// src/index.js
//
// Express application entry point.
//
// MIDDLEWARE STACK ORDER (order is critical in Express):
//   1. helmet          — security headers
//   2. cors            — cross-origin resource sharing
//   3. express.json    — parse JSON bodies
//   4. cookieParser    — parse cookies (needed for refresh_token HTTP-only cookie)
//   5. requestLogger   — audit log every request (runs before routes)
//   6. /auth routes    — authentication (rate-limited, public entry points)
//   7. /api routes     — protected APIs (require X-API-Version: 1 header)
//   8. 404 handler
//   9. error handler
//
// API VERSIONING:
//   The requireApiVersion middleware is mounted on the /api router.
//   This enforces X-API-Version: 1 on ALL /api/* endpoints without
//   having to add it to every individual route.

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { requestLogger } from './middleware/requestLogger.js';
import { requireApiVersion } from './middleware/apiVersion.js';
import authRouter from './routes/auth.js';
import profilesRouter from './routes/profiles.js';
import usersRouter from './routes/users.js';

// Importing DB triggers schema creation + seeding
import './config/database.js';

const app = express();
const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// SECURITY HEADERS
// helmet sets Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, etc.
// ---------------------------------------------------------------------------
app.use(helmet({
  // Relax CSP for development (in production you'd configure this tightly)
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
}));

// ---------------------------------------------------------------------------
// CORS
// Must allow the web portal origin and enable credentials (for cookies).
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (CLI tools, curl, Postman)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,  // Required for cookies to be sent cross-origin
  allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Version', 'X-CSRF-Token'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ---------------------------------------------------------------------------
// BODY PARSING + COOKIES
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// AUDIT LOGGING — logs every request to DB + stdout
// ---------------------------------------------------------------------------
app.use(requestLogger);

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// /auth — no X-API-Version required, has its own rate limiting
app.use('/auth', authRouter);

// /api — requires X-API-Version: 1 header (enforced by requireApiVersion middleware)
const apiRouter = express.Router();
apiRouter.use(requireApiVersion);
apiRouter.use('/profiles', profilesRouter);
apiRouter.use('/users', usersRouter);
app.use('/api', apiRouter);

// Health check (no auth, no version header needed)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// ---------------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// 4-parameter signature tells Express this is an error handler.
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   Insighta Labs+ Backend  v3.0.0          ║
║   http://localhost:${PORT}                   ║
║                                           ║
║   Auth:     /auth/*                       ║
║   API:      /api/*  (X-API-Version: 1)   ║
║   Health:   /health                       ║
╚═══════════════════════════════════════════╝
  `);
});

export default app;
