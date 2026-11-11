const NodeCache = require('node-cache');
let Redis = null;
try {
  Redis = require('ioredis');
} catch (err) {
  // Graceful fallback if ioredis package is not installed on production server
}

// L1 Cache: High-speed In-Memory Cache (TTL: 300s = 5m, Max 5000 keys, zero-clone for high concurrency)
const memoryCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 120,
  maxKeys: 5000,
  useClones: false
});

// L2 Cache: Redis Cache (Multi-Tenant & Distributed across instances)
const CACHE_INVALIDATE_CHANNEL = 'vijaysetu:cache_invalidate';
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let redisClient = null;
let redisSubClient = null;
let isRedisReady = false;

const redisUrl = process.env.REDIS_URL || process.env.REDIS_URI;

if (redisUrl && Redis) {
  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => {
        if (times > 5) return null; // Stop retrying after 5 attempts
        return Math.min(times * 500, 2000);
      },
      connectTimeout: 3000,
      lazyConnect: true,
    });

    redisClient.on('connect', () => {
      console.log('⚡ [Cache] Redis connected successfully!');
      isRedisReady = true;
    });

    redisClient.on('ready', () => {
      isRedisReady = true;
    });

    redisClient.on('error', (err) => {
      if (isRedisReady) {
        console.warn('⚠️ [Cache] Redis connection lost, switching to in-memory fallback:', err.message);
      }
      isRedisReady = false;
    });

    redisClient.on('close', () => {
      isRedisReady = false;
    });

    redisClient.connect().then(() => {
      // Cross-instance L1 eviction subscriber so Server A, B, C stay 100% consistent
      try {
        redisSubClient = redisClient.duplicate();
        redisSubClient.on('error', () => {});
        redisSubClient.subscribe(CACHE_INVALIDATE_CHANNEL).catch(() => {});
        redisSubClient.on('message', (channel, payload) => {
          if (channel !== CACHE_INVALIDATE_CHANNEL) return;
          try {
            const msg = JSON.parse(payload);
            if (msg.origin === INSTANCE_ID) return;
            if (msg.type === 'del' && msg.key) memoryCache.del(msg.key);
            else if (msg.type === 'prefix' && msg.prefix) {
              for (const k of memoryCache.keys()) {
                if (k.startsWith(msg.prefix)) memoryCache.del(k);
              }
            } else if (msg.type === 'flush') {
              memoryCache.flushAll();
            }
          } catch {}
        });
      } catch {}
    }).catch((err) => {
      console.warn('⚠️ [Cache] Redis initial connection failed, using in-memory cache:', err.message);
      isRedisReady = false;
    });
  } catch (err) {
    console.warn('⚠️ [Cache] Failed to initialize Redis client, using in-memory cache:', err.message);
  }
} else {
  console.log('ℹ️ [Cache] No REDIS_URL configured; using in-memory high-speed cache.');
}

function broadcastInvalidation(msg) {
  if (isRedisReady && redisClient) {
    redisClient.publish(CACHE_INVALIDATE_CHANNEL, JSON.stringify({ origin: INSTANCE_ID, ...msg })).catch(() => {});
  }
}

const cache = {
  // Synchronous getter (compatible with existing code)
  get(key) {
    return memoryCache.get(key);
  },

  // Asynchronous getter (checks L1 memory first, then L2 Redis)
  async getAsync(key) {
    const memVal = memoryCache.get(key);
    if (memVal !== undefined) return memVal;

    if (isRedisReady && redisClient) {
      try {
        const raw = await redisClient.get(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          // Populate L1 cache for subsequent instantaneous reads
          memoryCache.set(key, parsed);
          return parsed;
        }
      } catch (err) {
        console.warn(`[Cache] Redis get error for key ${key}:`, err.message);
      }
    }
    return undefined;
  },

  // Synchronous/fire-and-forget setter
  set(key, val, ttlSeconds = 300) {
    memoryCache.set(key, val, ttlSeconds);
    if (isRedisReady && redisClient) {
      try {
        const serialized = JSON.stringify(val);
        redisClient.set(key, serialized, 'EX', ttlSeconds).catch(() => {});
      } catch {
        // Serialization or network issue
      }
    }
    return true;
  },

  // Asynchronous setter
  async setAsync(key, val, ttlSeconds = 300) {
    memoryCache.set(key, val, ttlSeconds);
    if (isRedisReady && redisClient) {
      try {
        const serialized = JSON.stringify(val);
        await redisClient.set(key, serialized, 'EX', ttlSeconds);
      } catch (err) {
        console.warn(`[Cache] Redis set error for key ${key}:`, err.message);
      }
    }
    return true;
  },

  // Delete key
  del(key) {
    memoryCache.del(key);
    if (isRedisReady && redisClient) {
      redisClient.del(key).catch(() => {});
    }
    broadcastInvalidation({ type: 'del', key });
    return true;
  },

  // Asynchronous delete
  async delAsync(key) {
    memoryCache.del(key);
    if (isRedisReady && redisClient) {
      try {
        await redisClient.del(key);
      } catch (err) {
        console.warn(`[Cache] Redis del error for key ${key}:`, err.message);
      }
    }
    broadcastInvalidation({ type: 'del', key });
    return true;
  },

  // Invalidate all keys matching prefix
  delPrefix(prefix) {
    // 1. Delete from in-memory cache
    const memKeys = memoryCache.keys();
    memKeys.forEach((k) => {
      if (k.startsWith(prefix)) memoryCache.del(k);
    });

    // 2. Delete from Redis via non-blocking SCAN stream
    if (isRedisReady && redisClient) {
      const stream = redisClient.scanStream({
        match: `${prefix}*`,
        count: 100,
      });
      stream.on('data', (keys) => {
        if (keys && keys.length) {
          redisClient.del(...keys).catch(() => {});
        }
      });
      stream.on('error', () => {});
    }
    broadcastInvalidation({ type: 'prefix', prefix });
  },

  // Get in-memory keys
  keys() {
    return memoryCache.keys();
  },

  // Flush all
  flush() {
    memoryCache.flushAll();
    if (isRedisReady && redisClient) {
      redisClient.flushdb().catch(() => {});
    }
  },

  flushAll() {
    this.flush();
  },

  // Status reporter for System Health & Telemetry
  getStatus() {
    return {
      engine: isRedisReady ? 'redis' : 'memory',
      isRedisReady,
      memoryKeysCount: memoryCache.keys().length,
      redisConfigured: Boolean(redisUrl),
    };
  },
};

module.exports = cache;
