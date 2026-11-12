const express = require('express');
const dotenv = require('dotenv');
const compression = require('compression');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const logger = require('./lib/logger');
const { sanitizeInput } = require('./middleware/sanitizeMiddleware');
const {
  getClientIp,
  ipBlockMiddleware,
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
} = require('./middleware/securityMiddleware');
const { idempotencyMiddleware } = require('./middleware/idempotencyMiddleware');
const db = require('./db');

const authRoutes = require('./routes/auth');
const voterRoutes = require('./routes/voters');
const whatsappRoutes = require('./routes/whatsapp');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');
const featureRoutes = require('./routes/features');
const adminPdfRoutes = require('./routes/admin_pdf');
const rbacRoutes = require('./routes/rbac');
const { captureException } = require('./lib/errorTracker');
const { toUtcIso, DEFAULT_TIMEZONE } = require('./lib/dateUtils');

const app = express();
const PORT = process.env.PORT || 5002;

// Trust single edge proxy hop (Vercel/Render/Nginx/Cloudflare) safely for accurate rate limiting
app.set('trust proxy', 1);
app.disable('x-powered-by');

// 1. Permissive CORS first so preflights and error responses always succeed cleanly
app.use(createCorsMiddleware());

// 2. HTTP Security Headers
app.use(createHelmetMiddleware());

// 3. Fast Gzip/Brotli Compression
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// 4. Bounded IP Block & Exploit Scanner Protection
app.use(ipBlockMiddleware);

// 5. Payload Parsers (Strict limits to mitigate RAM DoS while supporting slip previews & bulk edits)
// Capture rawBuffer on Meta webhook route so HMAC-SHA256 x-hub-signature-256 verification stays exact
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/whatsapp/webhook')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// 6. Anti-NoSQL-Injection, Null-Byte, Depth & Prototype Pollution Guard
app.use(sanitizeInput);

// Static files cleanly scoped without permissive dotfiles exposure
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { dotfiles: 'ignore', maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'ignore', maxAge: '1d' }));

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    const dbState = mongoose.connection.readyState === 1 ? 'connected' : 'connecting_or_down';
    res.json({
      status: dbState === 'connected' ? 'ok' : 'degraded',
      database: dbState,
      uptimeSec: Math.round(process.uptime()),
      security: getSecurityStats(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Health check failed', { message: err.message });
    res.status(503).json({ status: 'degraded', database: 'error' });
  }
});

// Legal Policy Routes
app.get(['/privacy', '/privacy.html'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get(['/terms', '/terms.html'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get(['/refund', '/refund.html'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'refund.html')));
app.get(['/contact', '/contact.html'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));

app.get('/api/legal/policies', (req, res) => {
  const host = req.get('host') || 'localhost:5002';
  const proto = req.protocol || 'http';
  res.json({
    platform: 'VijaySetu (विजयसेतु)',
    version: '2026.1',
    effectiveDate: '2026-01-01',
    lastUpdated: new Date().toISOString(),
    policies: {
      privacy: { title: 'Privacy Policy (गोपनीयता नीति)', path: '/privacy.html', url: `${proto}://${host}/privacy.html` },
      terms: { title: 'Terms of Service (नियम और शर्तें)', path: '/terms.html', url: `${proto}://${host}/terms.html` },
      refund: { title: 'Refund Policy (धनवापसी नीति)', path: '/refund.html', url: `${proto}://${host}/refund.html` },
      contact: { title: 'Contact & Grievance (संपर्क एवं शिकायत)', path: '/contact.html', url: `${proto}://${host}/contact.html` }
    },
    compliance: {
      eciGuidelinesCompliant: true,
      itAct2000Compliant: true,
      dpdpAct2023Compliant: true,
      metaWhatsAppCloudApiCompliant: true,
      commercialDataSaleProhibited: true
    }
  });
});

// 7. Tiered Rate Limiting & Concurrency Idempotency Protection
app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/admin/leads', publicLeadLimiter);
app.use('/api/admin/pdf/upload', uploadLimiter);
app.use('/api/admin/upload-voters', uploadLimiter);
app.use('/api/voters/all', heavyReadLimiter);
app.use('/api/features/export.xlsx', heavyReadLimiter);
app.use('/api/admin/export-voters', heavyReadLimiter);
app.use('/api/whatsapp/send-slip', mutationLimiter);
app.use('/api/whatsapp/send-manual', mutationLimiter);
app.use('/api/whatsapp/campaign/send', mutationLimiter);

// Attach Idempotency-Key replay/in-flight shield for API mutations
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return idempotencyMiddleware()(req, res, next);
  }
  return next();
});

// Structured Request Logging
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    logger.info(`Incoming Request: ${req.method} ${req.url}`, { ip: getClientIp(req) });
  }
  next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/voters', voterRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/features', featureRoutes.router);
app.use('/api/admin/pdf', adminPdfRoutes);
app.use('/api/rbac', rbacRoutes);

app.get('/api/meta/version', (_req, res) => {
  res.json({
    apiVersion: '2026.1',
    minSupportedClientVersion: '2026.1',
    serverUtc: toUtcIso(),
    defaultTimeZone: DEFAULT_TIMEZONE,
    stateless: true,
  });
});

app.get('/', (_req, res) => {
  res.send('VijaySetu Electoral Intelligence Backend API is running.');
});

// Zero-Leak Global Error Handler
app.use(globalErrorHandler);

// Automated Daily Database Snapshot Cron (03:00 AM IST, skipped during test runs or when replica sets ENABLE_AUTO_BACKUP=false)
let backupCronJob = null;
if (process.env.NODE_ENV !== 'test' && process.env.ENABLE_AUTO_BACKUP !== 'false' && require.main === module) {
  const { createDatabaseBackup } = require('./lib/backupService');
  backupCronJob = cron.schedule(
    '0 3 * * *',
    async () => {
      try {
        if (mongoose.connection.readyState === 1) {
          await createDatabaseBackup({ label: 'daily-cron', triggeredBy: 'cron' });
        }
      } catch (err) {
        captureException(err, { path: 'cron:daily-backup' });
        logger.error('Automated daily DB backup failed', { message: err.message });
      }
    },
    { timezone: 'Asia/Kolkata' }
  );
}

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const id = captureException(err, { path: 'process:unhandledRejection' });
  logger.error(`Unhandled Rejection [${id}]`, { message: err.message });
});

const http = require('node:http');
const { initSocket, closeSocket } = require('./lib/socket');

const startServer = () => {
  const httpServer = http.createServer(app);
  initSocket(httpServer);
  const server = httpServer.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;
  return server;
};

// Graceful shutdown so active DB writes/backups finish cleanly before exit
function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down cleanly...`);
    if (backupCronJob) backupCronJob.stop();
    closeSocket();
    if (server) {
      server.close(async () => {
        await db.stopDB();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    } else {
      await db.stopDB();
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  db.connectDB()
    .then(() => {
      const server = startServer();
      setupGracefulShutdown(server);
    })
    .catch((err) => {
      logger.error('Database startup failed', { message: err.message });
      process.exit(1);
    });
}

module.exports = { app, startServer };
