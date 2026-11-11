const cache = require('./cache');

/**
 * Outbound Resilience Service:
 *  - Circuit Breaker (CLOSED -> OPEN -> HALF_OPEN) per external provider
 *  - Exponential Backoff + Equal Jitter (honors Retry-After, skips non-retryable 4xx)
 *  - Bounded Concurrency Queue (prevents connection/I/O exhaustion)
 *  - Daily Free-Tier Budget Guard (prevents runaway upstream billing spikes)
 */

const PROVIDER_DEFAULTS = {
  meta_whatsapp: { failureThreshold: 5, cooldownMs: 45_000, maxConcurrent: 6, dailyLimit: Number.parseInt(process.env.META_DAILY_CAP || '5000', 10) },
  cloudinary: { failureThreshold: 5, cooldownMs: 45_000, maxConcurrent: 4, dailyLimit: Number.parseInt(process.env.CLOUDINARY_DAILY_CAP || '2500', 10) },
  openrouter: { failureThreshold: 4, cooldownMs: 60_000, maxConcurrent: 3, dailyLimit: Number.parseInt(process.env.LLM_DAILY_CAP || '500', 10) },
  groq: { failureThreshold: 4, cooldownMs: 60_000, maxConcurrent: 3, dailyLimit: Number.parseInt(process.env.LLM_DAILY_CAP || '500', 10) },
};

const circuits = new Map();
const queues = new Map();

function getTodayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

function getProviderConfig(provider) {
  return PROVIDER_DEFAULTS[provider] || { failureThreshold: 5, cooldownMs: 30_000, maxConcurrent: 4, dailyLimit: 5000 };
}

function getCircuit(provider) {
  if (!circuits.has(provider)) {
    circuits.set(provider, { state: 'CLOSED', failures: 0, openedAt: 0, lastError: null });
  }
  return circuits.get(provider);
}

function getQueueState(provider) {
  if (!queues.has(provider)) {
    queues.set(provider, { active: 0, pending: [] });
  }
  return queues.get(provider);
}

function runInBoundedQueue(provider, fn) {
  const { maxConcurrent } = getProviderConfig(provider);
  const q = getQueueState(provider);

  return new Promise((resolve, reject) => {
    const start = () => {
      q.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          q.active = Math.max(0, q.active - 1);
          const next = q.pending.shift();
          if (next) next();
        });
    };

    if (q.active < maxConcurrent) {
      start();
    } else if (q.pending.length >= 250) {
      const err = new Error(`Outbound queue saturated for ${provider}`);
      err.code = 'OUTBOUND_QUEUE_FULL';
      reject(err);
    } else {
      q.pending.push(start);
    }
  });
}

async function consumeDailyBudget(provider) {
  const { dailyLimit } = getProviderConfig(provider);
  if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) return { allowed: true, used: 0, limit: dailyLimit };

  const key = `outbound:quota:${provider}:${getTodayUtcKey()}`;
  const current = (await cache.getAsync(key)) || 0;
  if (current >= dailyLimit) {
    return { allowed: false, used: current, limit: dailyLimit };
  }
  cache.set(key, current + 1, 26 * 3600);
  return { allowed: true, used: current + 1, limit: dailyLimit };
}

function isRetryableError(err) {
  const status = err?.response?.status || err?.status;
  if (status) {
    return status === 408 || status === 429 || status >= 500;
  }
  const code = err?.code || '';
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code) || !status;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, { maxRetries = 2, baseDelayMs = 400, maxDelayMs = 6000 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableError(err)) {
        throw err;
      }
      const retryAfterSec = Number.parseInt(err?.response?.headers?.['retry-after'], 10);
      let waitMs;
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        waitMs = Math.min(maxDelayMs, retryAfterSec * 1000);
      } else {
        const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        waitMs = Math.floor(cap / 2 + Math.random() * (cap / 2)); // Equal jitter prevents thundering herd
      }
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

/**
 * Execute an external third-party call guarded by daily free-tier budget,
 * circuit breaker, bounded concurrency queue, and exponential backoff.
 */
async function executeWithResilience(provider, taskFn, { maxRetries = 2, baseDelayMs = 400, countBudget = true } = {}) {
  const cfg = getProviderConfig(provider);
  const circuit = getCircuit(provider);

  if (circuit.state === 'OPEN') {
    const elapsed = Date.now() - circuit.openedAt;
    if (elapsed < cfg.cooldownMs) {
      const err = new Error(`Upstream service ${provider} circuit open (${Math.ceil((cfg.cooldownMs - elapsed) / 1000)}s cooldown)`);
      err.code = 'CIRCUIT_OPEN';
      err.status = 503;
      throw err;
    }
    circuit.state = 'HALF_OPEN';
  }

  if (countBudget) {
    const budget = await consumeDailyBudget(provider);
    if (!budget.allowed) {
      const err = new Error(`Daily free-tier safety limit (${budget.limit}) reached for ${provider}.`);
      err.code = 'BUDGET_EXCEEDED';
      err.status = 429;
      throw err;
    }
  }

  try {
    const result = await runInBoundedQueue(provider, () => retryWithBackoff(taskFn, { maxRetries, baseDelayMs }));
    circuit.state = 'CLOSED';
    circuit.failures = 0;
    circuit.lastError = null;
    return result;
  } catch (err) {
    if (isRetryableError(err)) {
      circuit.failures += 1;
      circuit.lastError = err.message;
      if (circuit.failures >= cfg.failureThreshold) {
        circuit.state = 'OPEN';
        circuit.openedAt = Date.now();
        console.warn(`⚡ [CircuitBreaker] Opened circuit for ${provider} after ${circuit.failures} failures.`);
      }
    }
    throw err;
  }
}

function getOutboundHealthSnapshot() {
  const snapshot = {};
  for (const provider of Object.keys(PROVIDER_DEFAULTS)) {
    const c = getCircuit(provider);
    const q = getQueueState(provider);
    const cfg = getProviderConfig(provider);
    const used = cache.get(`outbound:quota:${provider}:${getTodayUtcKey()}`) || 0;
    snapshot[provider] = {
      circuitState: c.state,
      consecutiveFailures: c.failures,
      activeJobs: q.active,
      queuedJobs: q.pending.length,
      dailyUsed: used,
      dailyLimit: cfg.dailyLimit,
    };
  }
  return snapshot;
}

module.exports = {
  executeWithResilience,
  retryWithBackoff,
  getOutboundHealthSnapshot,
};

