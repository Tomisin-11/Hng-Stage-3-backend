// src/middleware/apiVersion.js
//
// TRD REQUIREMENT:
//   All /api/* endpoints must include the header:
//     X-API-Version: 1
//
//   Requests without this header are rejected:
//   {
//     "status": "error",
//     "message": "API version header required"
//   }
//   HTTP 400 Bad Request
//
// We mount this middleware on the /api router so it runs before any route handler.

import { sendError } from '../utils/response.js';

export function requireApiVersion(req, res, next) {
  const version = req.headers['x-api-version'];

  if (!version) {
    return sendError(res, 'API version header required', 400);
  }

  // Currently only v1 is supported
  if (version !== '1') {
    return sendError(res, `Unsupported API version: ${version}. Supported: 1`, 400);
  }

  next();
}
