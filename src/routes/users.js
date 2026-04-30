// src/routes/users.js
//
// User management — admin only.
//
//   GET   /api/users           — list all users
//   GET   /api/users/:id       — single user
//   PATCH /api/users/:id/role  — change role
//   PATCH /api/users/:id/status — activate/deactivate (sets is_active)

import { Router } from 'express';
import { protect, requireRole } from '../middleware/auth.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import { sendSuccess, sendError } from '../utils/response.js';
import db from '../config/database.js';

const router = Router();

// All user management is admin-only
router.use(...protect, requireRole('admin'), apiLimiter);

// List users
router.get('/', (req, res) => {
  const users = db.prepare(
    `SELECT id, github_id, username, email, avatar_url, role, is_active,
            last_login_at, created_at FROM users ORDER BY created_at DESC`
  ).all();
  return sendSuccess(res, { data: users, total: users.length });
});

// Single user
router.get('/:id', (req, res) => {
  const user = db.prepare(
    `SELECT id, github_id, username, email, avatar_url, role, is_active,
            last_login_at, created_at FROM users WHERE id = ?`
  ).get(req.params.id);
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, { data: user });
});

// Change role
router.patch('/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['admin', 'analyst'].includes(role)) {
    return sendError(res, 'Invalid role. Allowed: admin, analyst');
  }
  if (req.params.id === req.user.id) {
    return sendError(res, 'Cannot change your own role');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return sendError(res, 'User not found', 404);

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  return sendSuccess(res, { message: `Role updated to ${role}`, user_id: req.params.id });
});

// Activate / deactivate user
router.patch('/:id/status', (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return sendError(res, 'is_active must be a boolean');
  }
  if (req.params.id === req.user.id) {
    return sendError(res, 'Cannot deactivate your own account');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return sendError(res, 'User not found', 404);

  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id);
  return sendSuccess(res, {
    message: `User ${is_active ? 'activated' : 'deactivated'}`,
    user_id: req.params.id,
  });
});

export default router;
