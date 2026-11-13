/**
 * Enterprise Input Sanitization & Anti-NoSQL-Injection Middleware
 * Prevents:
 * 1. MongoDB $gt, $ne, $where, $regex, $expr operator injection
 * 2. Prototype Pollution (__proto__, constructor, prototype)
 * 3. Null byte poisoning (%00 / \0)
 * 4. Giant string / oversized array / deep object DoS attacks
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 10;
const MAX_ARRAY_LENGTH = 5000;
const MAX_STRING_LENGTH = 100000; // General string limit
const MAX_DATA_URL_LENGTH = 15 * 1024 * 1024; // 15MB for slip and candidate images (prevents JPEG truncation)

function sanitizeObject(obj, isQuery = false, depth = 0, currentKey = '') {
  if (depth > MAX_DEPTH) return {};

  if (Array.isArray(obj)) {
    const bounded = obj.length > MAX_ARRAY_LENGTH ? obj.slice(0, MAX_ARRAY_LENGTH) : obj;
    return bounded.map((item) => sanitizeObject(item, isQuery, depth + 1, currentKey));
  }

  if (obj !== null && typeof obj === 'object') {
    const clean = {};
    for (const [key, value] of Object.entries(obj)) {
      if (DANGEROUS_KEYS.has(key)) continue;

      if (key.startsWith('$') || key.includes('\0')) {
        continue;
      }

      if (isQuery && typeof key === 'string' && key.includes('.')) {
        continue;
      }

      clean[key] = sanitizeObject(value, isQuery, depth + 1, key);
    }
    return clean;
  }

  if (typeof obj === 'string') {
    let str = obj.replace(/\0/g, '');
    const isImagePayload =
      str.startsWith('data:image/') ||
      str.startsWith('data:application/') ||
      /^(slipImageDataUrl|headerGraphicImage|candidateImage|partySymbolImage)$/i.test(currentKey) ||
      currentKey.toLowerCase().includes('dataurl');

    const limit = isImagePayload ? MAX_DATA_URL_LENGTH : MAX_STRING_LENGTH;
    if (str.length > limit) {
      str = str.slice(0, limit);
    }
    return str;
  }

  return obj;
}

function sanitizeInput(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body, false, 0);
    }
    if (req.query && typeof req.query === 'object') {
      const sanitizedQuery = sanitizeObject(req.query, true, 0);
      for (const k of Object.keys(req.query)) {
        delete req.query[k];
      }
      Object.assign(req.query, sanitizedQuery);
    }
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params, true, 0);
    }
    return next();
  } catch (err) {
    console.error('Sanitizer error:', err.message);
    return res.status(400).json({ message: 'Invalid request payload format.' });
  }
}

module.exports = { sanitizeInput, sanitizeObject };
