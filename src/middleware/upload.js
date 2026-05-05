// src/middleware/upload.js
//
// Multer configuration for CSV file uploads.
//
// Why disk storage (not memory storage)?
//   Memory storage loads the entire file into RAM before processing.
//   At 500k rows (~100MB), that would exhaust memory and block the server.
//   Disk storage writes the upload to a temp file — we then stream it
//   line-by-line in the ingestion service, using only a small buffer.
//
// Why a 150MB size limit?
//   500k rows × ~200 bytes per row (name, gender, age, country) ≈ 100MB.
//   150MB gives headroom for wider rows or extra columns.

import multer from 'multer';
import path from 'path';
import os from 'os';

const storage = multer.diskStorage({
  // Use the OS temp directory — cleaned up by the ingestion handler after processing
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),

  filename: (_req, file, cb) => {
    // Prefix with timestamp to avoid collisions during concurrent uploads
    const ts = Date.now();
    const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `insighta_upload_${ts}_${safe}`);
  },
});

function fileFilter(_req, file, cb) {
  // Accept only CSV files — check both mimetype and extension
  const isCSV =
    file.mimetype === 'text/csv' ||
    file.mimetype === 'application/vnd.ms-excel' || // Some clients send this for .csv
    file.originalname.toLowerCase().endsWith('.csv');

  if (isCSV) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV files are accepted'), false);
  }
}

export const uploadCSV = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 150 * 1024 * 1024, // 150MB max
    files: 1,                     // One file per request
  },
}).single('file'); // Expect field name 'file' in the multipart form
