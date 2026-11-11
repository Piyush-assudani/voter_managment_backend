const crypto = require('node:crypto');
const cache = require('../lib/cache');
const { getClientIp } = require('./securityMiddleware');

const IDEMPOTENCY_TTL_SEC = 300; // 5 minutes
const IN_FLIGHT_PREFIX = 'idem:inflight:';
const RESULT_PREFIX = 'idem:result:';

// Local atomic lock guard to serialize identical concurrent millisecond clicks inside this process
const localInFlightLocks = new Map();

function resolveActorScope(req) {
  if (req.user?.id) return `u:${req.user.id}`;
  const auth = req.headers?.authorization;
  if (auth && typeof auth === 'string' && auth.length > 10) {
    const hash = crypto.createHash('sha256').update(auth).digest('hex').slice(0, 16);
    return `tok:${hash}`;
  }
  return `ip:${getClientIp(req)}`;
}

/**
 * Normalize an incoming Idempotency-Key header. Returns null if absent or malformed.
 */
function extractIdempotencyKey(req) {
  const raw = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Concurrency & double-click idempotency middleware.
 * Scopes keys strictly per (user/IP + HTTP method + normalized path + Idempotency-Key).
 * Prevents 1000 simultaneous clicks from double-charging credits or creating duplicate rows.
 */
function idempotencyMiddleware(options = {}) {
  const ttlSec = options.ttlSec || IDEMPOTENCY_TTL_SEC;

  return async (req, res, next) => {
    const key = extractIdempotencyKey(req);
    if (!key) return next();

    const actor = resolveActorScope(req);
    const scopeKey = `${actor}:${req.method}:${req.baseUrl}${req.path}:${key}`;
    const resultCacheKey = `${RESULT_PREFIX}${scopeKey}`;

    try {
      // 1. Check completed response replay (L1 + L2 Redis)
      const cached = await cache.getAsync(resultCacheKey);
      if (cached && typeof cached.status === 'number') {
        res.setHeader('X-Idempotent-Replayed', 'true');
        return res.status(cached.status).json(cached.body);
      }

      // 2. Check concurrent in-flight execution in same instance or Redis
      if (localInFlightLocks.has(scopeKey)) {
        return res.status(409).json({
          success: false,
          inProgress: true,
          message: 'यह अनुरोध पहले से प्रक्रिया में है। कृपया प्रतीक्षा करें।'
        });
      }

      const remoteInFlight = await cache.getAsync(`${IN_FLIGHT_PREFIX}${scopeKey}`);
      if (remoteInFlight) {
        return res.status(409).json({
          success: false,
          inProgress: true,
          message: 'यह अनुरोध पहले से प्रक्रिया में है। कृपया प्रतीक्षा करें।'
        });
      }

      localInFlightLocks.set(scopeKey, Date.now());
      cache.set(`${IN_FLIGHT_PREFIX}${scopeKey}`, { startedAt: Date.now() }, 30);

      // Intercept res.json to capture & cache successful/deterministic responses cleanly
      const originalJson = res.json.bind(res);
      let finalized = false;

      const releaseLock = () => {
        if (finalized) return;
        finalized = true;
        localInFlightLocks.delete(scopeKey);
        cache.del(`${IN_FLIGHT_PREFIX}${scopeKey}`);
      };

      res.json = (body) => {
        const status = res.statusCode || 200;
        // Cache 2xx and deterministic 4xx (not 5xx transient server failures or 409 lock conflicts)
        if (status >= 200 && status < 500 && status !== 409 && status !== 429) {
          cache.set(resultCacheKey, { status, body }, ttlSec);
        }
        releaseLock();
        return originalJson(body);
      };

      res.on('close', releaseLock);
      res.on('finish', releaseLock);

      return next();
    } catch (err) {
      localInFlightLocks.delete(scopeKey);
      return next();
    }
  };
}

module.exports = {
  idempotencyMiddleware,
  extractIdempotencyKey
};
