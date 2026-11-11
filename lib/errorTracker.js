const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Bounded, PII-safe structured Error Tracker backed by MongoDB (30-day TTL) + fingerprint dedup.
 * Stack traces remain strictly server-side; clients receive only an opaque errorId reference.
 */
const errorLogSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  fingerprint: { type: String, required: true, unique: true },
  errorName: { type: String, default: 'Error' },
  message: { type: String, required: true },
  stack: { type: String, default: '' },
  method: { type: String, default: 'SYSTEM' },
  path: { type: String, default: 'internal' },
  statusCode: { type: Number, default: 500 },
  userId: { type: String, default: null },
  organizationId: { type: String, default: null },
  occurrences: { type: Number, default: 1 },
  resolved: { type: Boolean, default: false, index: true },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
});

// Auto-expire resolved/old telemetry after 30 days to keep database size minimal
errorLogSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const ErrorLog = mongoose.models.ErrorLog || mongoose.model('ErrorLog', errorLogSchema);

function redactSensitive(value) {
  if (!value) return '';
  return String(value)
    .replace(/(bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/(mongodb(\+srv)?:\/\/)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([a-z0-9_-]*secret|password|token|apiKey)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}

/**
 * Capture and deduplicate an exception asynchronously (never blocks HTTP response).
 */
function captureException(err, context = {}) {
  const errorId = `err_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const errorName = err?.name || 'Error';
  const message = redactSensitive(err?.message || String(err || 'Unknown server error'));
  const stack = redactSensitive(err?.stack || '');
  const method = String(context.method || 'SYSTEM').slice(0, 12);
  const reqPath = String(context.path || 'internal').split('?')[0].slice(0, 160);
  const statusCode = Number(context.statusCode) || 500;

  const fingerprint = crypto
    .createHash('sha256')
    .update(`${errorName}|${method}|${reqPath}|${message.slice(0, 180)}`)
    .digest('hex')
    .slice(0, 32);

  if (mongoose.connection.readyState === 1) {
    ErrorLog.updateOne(
      { fingerprint },
      {
        $setOnInsert: {
          _id: errorId,
          fingerprint,
          firstSeenAt: new Date(),
        },
        $set: {
          errorName,
          message,
          stack,
          method,
          path: reqPath,
          statusCode,
          userId: context.userId || null,
          organizationId: context.organizationId || null,
          resolved: false,
          lastSeenAt: new Date(),
        },
        $inc: { occurrences: 1 },
      },
      { upsert: true }
    ).catch((dbErr) => {
      console.warn('[ErrorTracker] Async DB persist skipped:', dbErr.message);
    });
  }

  return errorId;
}

async function listRecentErrors({ limit = 50, includeResolved = false } = {}) {
  const filter = includeResolved ? {} : { resolved: false };
  return ErrorLog.find(filter)
    .sort({ lastSeenAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .lean();
}

async function resolveTrackedError(id) {
  return ErrorLog.findByIdAndUpdate(id, { $set: { resolved: true } }, { returnDocument: 'after' }).lean();
}

module.exports = {
  ErrorLog,
  captureException,
  listRecentErrors,
  resolveTrackedError,
};

