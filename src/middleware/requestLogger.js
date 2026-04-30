// src/middleware/requestLogger.js
//
// TRD LOGGING REQUIREMENT — log on every request:
//   - Method
//   - Endpoint
//   - Status code
//   - Response time
//
// We capture response time by recording `Date.now()` before routing and
// writing the log in the 'finish' event (after headers are sent).

import db from '../config/database.js';
import { uuidv7 } from '../config/database.js';

const insertLog = db.prepare(`
  INSERT INTO request_logs (id, user_id, method, endpoint, status_code, response_time_ms, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const responseTime = Date.now() - start;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] ?? req.ip;

    // Log to DB (non-blocking — errors are swallowed so logging never breaks the app)
    try {
      insertLog.run(
        uuidv7(),
        req.user?.id ?? null,
        req.method,
        req.path,
        res.statusCode,
        responseTime,
        ip,
        req.headers['user-agent'] ?? null
      );
    } catch { /* never crash on logging failure */ }

    // Also log to stdout for server console / deployment logs
    const color = res.statusCode >= 500 ? '\x1b[31m'  // red
                : res.statusCode >= 400 ? '\x1b[33m'  // yellow
                : '\x1b[32m';                          // green
    console.log(
      `${color}${req.method}\x1b[0m ${req.path} → ${res.statusCode} (${responseTime}ms)`
    );
  });

  next();
}
