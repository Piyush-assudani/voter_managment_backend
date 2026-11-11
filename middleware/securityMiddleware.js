const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { captureException } = require('../lib/errorTracker');

const MAX_TRACKED_IPS = 10000;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes rolling auto-ban
const VIOLATION_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_THRESHOLD = 35;

/**
 * Bounded Map<string, { count: number, firstAt: number, lastReason: string }>
 */
const ipViolationTracker = new Map();

/**
 * Bounded Map<string, { expiresAt: number, reason: string }>
 */
const blockedIPs = new Map();

/**
 * Normalize an IP address string cleanly (strips ::ffff: IPv4-mapped prefix).
 */
function normalizeIp(raw) {
  if (!raw || typeof raw !== 'string') return 'unknown';
  let ip = raw.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip.slice(0, 64);
}

/**
 * Extract trusted client IP without blindly trusting spoofable left-most X-Forwarded-For headers.
 * When Express `trust proxy` is configured carefully (e.g. `app.set('trust proxy', 1)`),
 * `req.ip` resolves the edge-proxy peer safely.
 */
function getClientIp(req) {
  const expressIp = normalizeIp(req.ip);
  if (expressIp && expressIp !== 'unknown') {
    return expressIp;
  }
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  return socketIp || 'unknown';
}

/**
 * FIFO eviction helper so attack traffic from spoofed/random IPs cannot exhaust Node heap.
 */
function setBounded(map, key, value, maxSize = MAX_TRACKED_IPS) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

// Background sweep every 5 minutes to purge expired bans & stale violation counters
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of blockedIPs.entries()) {
    if (entry.expiresAt <= now) blockedIPs.delete(ip);
  }
  for (const [ip, tracker] of ipViolationTracker.entries()) {
    if (now - tracker.firstAt > VIOLATION_WINDOW_MS) ipViolationTracker.delete(ip);
  }
}, 5 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

function recordSuspiciousActivity(ip, reason = 'Suspicious activity', weight = 1) {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1') return false;
  const now = Date.now();
  const prev = ipViolationTracker.get(ip);
  const tracker = !prev || now - prev.firstAt > VIOLATION_WINDOW_MS
    ? { count: 0, firstAt: now, lastReason: reason }
    : prev;

  tracker.count += weight;
  tracker.lastReason = reason;
  setBounded(ipViolationTracker, ip, tracker);

  if (tracker.count >= BLOCK_THRESHOLD) {
    setBounded(blockedIPs, ip, { expiresAt: now + BLOCK_DURATION_MS, reason });
    ipViolationTracker.delete(ip);
    console.warn(`🛡️ [SECURITY] Temporarily auto-blocked IP ${ip} for 15m (${reason})`);
    return true;
  }
  return false;
}

/**
 * Active IP Block & Scanner Guard Middleware
 */
function ipBlockMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const ban = blockedIPs.get(ip);

  if (ban) {
    if (ban.expiresAt > Date.now()) {
      const retryAfterSec = Math.max(1, Math.ceil((ban.expiresAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(403).json({
        success: false,
        message: 'असामान्य या संदिग्ध अनुरोधों के कारण इस आईपी को अस्थायी रूप से ब्लॉक किया गया है। कुछ समय बाद पुनः प्रयास करें।'
      });
    }
    blockedIPs.delete(ip);
  }

  // Detect automated vulnerability scanner / exploit probes immediately
  const rawUrl = (req.originalUrl || req.url || '').toLowerCase();
  if (
    rawUrl.includes('../') ||
    rawUrl.includes('..\\') ||
    rawUrl.includes('/.git') ||
    rawUrl.includes('/.env') ||
    rawUrl.includes('wp-login') ||
    rawUrl.includes('wp-admin') ||
    rawUrl.includes('phpmyadmin')
  ) {
    recordSuspiciousActivity(ip, `Exploit scanner probe: ${rawUrl.slice(0, 64)}`, 15);
    return res.status(403).json({
      success: false,
      message: 'अनधिकृत या अमान्य अनुरोध अस्वीकृत।'
    });
  }

  return next();
}

/**
 * Permissive CORS middleware (explicitly open across web, PWA, mobile, Vercel, Android APK)
 */
function createCorsMiddleware() {
  return (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  };
}

/**
 * Helmet HTTP security headers tuned not to break image previews or permissive CORS
 */
function createHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  });
}

function buildRateLimiter({ windowMs, max, message, keyByUser = true, weightOnLimit = 5 }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, default: true },
    keyGenerator: (req) => {
      if (keyByUser && req.user?.id) {
        return `user:${req.user.id}`;
      }
      return `ip:${getClientIp(req)}`;
    },
    handler: (req, res) => {
      const ip = getClientIp(req);
      recordSuspiciousActivity(ip, `Rate limit exceeded on ${req.path}`, weightOnLimit);
      res.status(429).json({ success: false, message });
    }
  });
}

const apiLimiter = buildRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  keyByUser: true,
  weightOnLimit: 8,
  message: 'बहुत अधिक अनुरोध भेजे गए हैं। कृपया 1 मिनट बाद पुनः प्रयास करें।'
});

const authLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyByUser: false,
  weightOnLimit: 4,
  message: 'सुरक्षा कारणों से बहुत अधिक लॉगिन प्रयास ब्लॉक किए गए हैं। 15 मिनट बाद पुनः प्रयास करें।'
});

const publicLeadLimiter = buildRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 8,
  keyByUser: false,
  weightOnLimit: 10,
  message: 'डेमो अनुरोध सीमा पार हो गई है। कृपया 1 घंटे बाद पुनः प्रयास करें।'
});

const uploadLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyByUser: true,
  weightOnLimit: 6,
  message: 'फ़ाइल अपलोड की सीमा पार हो गई है। कृपया कुछ समय बाद पुनः प्रयास करें।'
});

const heavyReadLimiter = buildRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 40,
  keyByUser: true,
  weightOnLimit: 5,
  message: 'डेटा एक्सपोर्ट / भारी लोड सीमा पार हो गई है। कृपया कुछ देर प्रतीक्षा करें।'
});

const mutationLimiter = buildRateLimiter({
  windowMs: 60 * 1000,
  max: 150,
  keyByUser: true,
  weightOnLimit: 4,
  message: 'बहुत तेज़ गति से बदलाव अनुरोध भेजे गए हैं। कृपया कुछ सेकंड रुककर प्रयास करें।'
});

/**
 * Zero-Leak Global Error Handler + Structured Error Tracker
 */
function globalErrorHandler(err, req, res, _next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: 'अमान्य JSON अनुरोध फॉर्मेट।'
    });
  }

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'अनुरोध डेटा आकार सीमा से अधिक है।'
    });
  }

  if (err && err.name === 'MulterError') {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      success: false,
      message: 'फ़ाइल अपलोड सीमा या प्रारूप अमान्य है।'
    });
  }

  if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
    return res.status(400).json({
      success: false,
      message: 'अमान्य डेटा प्रारूप या आईडी।'
    });
  }

  if (err && err.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'यह रिकॉर्ड पहले से मौजूद है।'
    });
  }

  const safeStatus = err?.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  let errorId = null;
  if (safeStatus === 500) {
    errorId = captureException(err, {
      method: req?.method,
      path: req?.originalUrl || req?.url,
      statusCode: safeStatus,
      userId: req?.user?.id || null,
      organizationId: req?.user?.organizationId || null,
    });
    console.error(`🔥 [UNHANDLED ERROR ${errorId}]:`, err?.message || err);
  }

  return res.status(safeStatus).json({
    success: false,
    ...(errorId ? { errorId } : {}),
    message: safeStatus < 500 && err?.message ? err.message : 'सर्वर पर आंतरिक त्रुटि हुई। कृपया पुनः प्रयास करें।'
  });
}

function getSecurityStats() {
  const now = Date.now();
  let activeBlocks = 0;
  for (const ban of blockedIPs.values()) {
    if (ban.expiresAt > now) activeBlocks += 1;
  }
  return {
    activeBlockedIps: activeBlocks,
    trackedSuspiciousIps: ipViolationTracker.size
  };
}

module.exports = {
  getClientIp,
  normalizeIp,
  ipBlockMiddleware,
  recordSuspiciousActivity,
  createCorsMiddleware,
  createHelmetMiddleware,
  apiLimiter,
  authLimiter,
  publicLeadLimiter,
  uploadLimiter,
  heavyReadLimiter,
  mutationLimiter,
  globalErrorHandler,
  getSecurityStats
};

