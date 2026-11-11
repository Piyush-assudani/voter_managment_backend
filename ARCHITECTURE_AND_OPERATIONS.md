# VijaySetu Architecture & Operations Guide

Concise reference for developers maintaining **VijaySetu** (`backend/` Node/Express + MongoDB/Mongoose, `frontend/` Next.js App Router). Designed to keep modules separated, prevent spaghetti dependencies, minimize database read/write cost, and guarantee zero silent data loss.

> **Full Documentation Suite:** See [`docs/PRD.md`](./docs/PRD.md), [`docs/TRD.md`](./docs/TRD.md), and [`docs/USER_MANUAL.md`](./docs/USER_MANUAL.md) for full product requirements, stateless scaling, normalized RBAC schemas (`Users`, `Roles`, `Permissions`, `Role_Permissions`), circuit breakers, offline-first sync, and user instructions.

---

## 1. Module Separation (No-Spaghetti Structure)

### Backend (`backend/`)
| Layer | Responsibility | Key Files |
|---|---|---|
| **App Bootstrap & Lifecycle** | Express wiring, JSON/body parsing (`rawBody` capture for webhook HMAC), cron scheduling, graceful shutdown | `index.js`, `db.js` |
| **Security & Edge Protection** | Open CORS (`*`), Helmet headers, bounded TTL IP auto-block, scanner-probe detection, tiered rate limiters, global error sanitizer | `middleware/securityMiddleware.js`, `middleware/sanitizeMiddleware.js` |
| **Authentication & Tenant Cache** | JWT verification (`getJwtSecret`), active-account & org-expiry checks backed by 60s L1/L2 cache | `middleware/authMiddleware.js`, `controllers/authController.js` |
| **Concurrency & Idempotency** | Atomic `Idempotency-Key` deduplication across simultaneous clicks (`in-flight` mutex + replay cache) | `middleware/idempotencyMiddleware.js` |
| **Persistence & Indexes** | Mongoose schemas, compound multi-tenant indexes, pruned redundant prefix indexes | `models/index.js` |
| **Backup & Disaster Recovery** | Atomic compressed `.json.gz` snapshots + SHA-256 checksum manifests + verified restore | `lib/backupService.js`, `scripts/backup_db.js` |
| **Feature Routers** | Isolated business routes by domain | `routes/auth.js`, `routes/voters.js`, `routes/features.js`, `routes/whatsapp.js`, `routes/users.js`, `routes/admin.js`, `routes/admin_pdf.js`, `routes/community.js`, `routes/analytics.js` |
| **Media & Helpers** | Cloudinary upload (strictly env-driven), family grouping, Devanagari glyph repair, LRU/Redis cache wrapper | `lib/cloudinaryService.js`, `lib/cache.js`, `lib/familyService.js`, `lib/voterHelpers.js` |

### Frontend (`frontend/src/`)
| Layer | Responsibility | Key Files |
|---|---|---|
| **API Transport** | Auth/org header injection, automatic `Idempotency-Key` on mutations, 30s/120s `AbortController` timeouts, suspension/rate-limit handling | `src/lib/api.ts` |
| **Next.js Proxy** | Local dev `/api/*` forwarding to configured `BACKEND_API_URL` | `src/app/api/[...path]/route.ts` |
| **Shared WhatsApp & UI** | Canvas slip image generation + `/whatsapp/send-manual` / `/whatsapp/send-slip` dispatch | `src/lib/whatsappShare.ts`, `src/components/VoterSlipTemplate.tsx` |
| **Dashboard Pages** | Isolated feature pages with in-flight click locks & optimistic state updates | `src/app/(dashboard)/*` |

---

## 2. Database Schema, Cost Optimization & Concurrency Contracts

### Indexing & Query Discipline (`backend/models/index.js`)
- Every query against `Voter` MUST lead with `organizationId` so compound indexes stay selective.
- **No `.collation({ locale: 'en' })` on sorted queries** unless backed by a matching collated index — otherwise MongoDB skips the B-tree index and performs an expensive in-memory collection sort.
- Single-pass `$facet` / `$group` aggregations are used on `/wards-summary`, `/panchayats-summary`, and `/issues-summary` to avoid scanning 20k+ voter documents multiple times per page load.
- Unbounded endpoints (e.g. `/voters/all`) enforce hard `.limit(...)` caps (`15000`) and slim field projections.

### Caching (`lib/cache.js` & `middleware/authMiddleware.js`)
- Auth checks cache `auth:user:<id>` and `auth:org:<id>` for 60s instead of hitting MongoDB on every API request.
- **Mandatory Invalidation Rule:** Any route modifying `User` (`isActive`, `passwordHash`, `role`, `assignedWards`, etc.) MUST call `invalidateUserAuthCache(userId)`. Any route modifying `Organization` (`isActive`, `expiresAt`, `wards`, `enabledModules`, `demo-suspend`) MUST call `invalidateOrgAuthCache(orgId)`.

### Concurrency & Double-Click Safety (1000 Simultaneous Clicks)
1. **Frontend:** Central `apiFetch()` attaches a unique `Idempotency-Key` header on `POST`/`PUT`/`PATCH`/`DELETE`; mutation handlers (`handleSendWhatsAppViaApi`, `handleSendDirectWhatsApp`, `toggleVote`, `markVoted`) guard with in-flight state flags.
2. **Middleware (`idempotencyMiddleware.js`):** Scopes keys by authenticated user ID (or SHA-256 hash of `Authorization` token, else IP) + method + path. Concurrent duplicates either wait briefly for completion or receive `409 DUPLICATE_IN_FLIGHT` / the cached identical response without re-running billing or writes.
3. **Atomic DB Updates:**
   - WhatsApp credits deduct BEFORE external API calls using atomic conditional update `Organization.findOneAndUpdate({ _id, whatsappEnabled: true, $expr: ... }, { $inc: { whatsappUsed: count } })`, with non-negative `$inc` guards on refunds and `PUT /whatsapp-credits`.
   - Worker account limits (`POST /api/users`, max 10 active workers) run a post-insert count check with automatic rollback (`User.deleteOne`) if concurrent requests race past the pre-check.

---

## 3. Security & Reliability Checklist

- **CORS Policy:** Intentionally kept wide open (`origin: '*'`, all standard methods & headers) for multi-domain Vercel + mobile/WhatsApp integrations. Security is enforced via JWT auth, tenant isolation, input sanitization, and rate limits rather than origin blocking.
- **Production Boot Fail-Fast (`db.js`):** In `NODE_ENV=production`, missing `MONGO_URI` or `JWT_SECRET` terminates startup cleanly instead of silently booting an ephemeral in-memory database or predictable fallback secret.
- **Admin Bootstrap:** Never hardcode default passwords in source. Initial admin creation uses `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` and will NOT overwrite existing passwords unless `BOOTSTRAP_FORCE_RESET=true` is explicitly set.
- **Input & Upload Guards:**
  - `sanitizeMiddleware.js`: strips MongoDB `$` operators, `__proto__`/`constructor`/`prototype`, null bytes, and caps nesting depth (`10`), array length (`5000`), and string length (`100KB`).
  - `admin_pdf.js`: ZIP uploads enforce `MAX_ZIP_FILES=50`, `50MB`/entry, `250MB` total uncompressed limit, `path.basename` sanitization, and `%PDF-` magic-byte checks.
  - `whatsapp.js`: Verifies Meta `x-hub-signature-256` HMAC when `META_APP_SECRET` is configured and validates cross-tenant authorization on every campaign endpoint.
- **Abuse & IP Protection (`securityMiddleware.js`):** Scanner probes (`.env`, `wp-admin`, `.git`) and repeated 401/429 bursts automatically block abusive IPs for 15 minutes inside a bounded `10,000`-entry TTL store.

---

## 4. Required Production Environment Variables

Never hardcode secrets in source files. Configure these in production (`.env` / platform dashboard):
- `MONGO_URI` — Primary MongoDB connection string (Atlas replica set recommended)
- `JWT_SECRET` — Strong random 64+ char secret (`openssl rand -hex 32`)
- `PUBLIC_URL` — Public backend HTTPS origin for generated slip links
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — Required for persistent slip/branding image hosting
- `META_WEBHOOK_VERIFY_TOKEN` & `META_APP_SECRET` — Required for Meta WhatsApp webhook verification & HMAC integrity
- `META_SYSTEM_USER_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WABA_ID` — Required for official WhatsApp Cloud API dispatch
- `BACKUP_DIR` (optional, default `backend/backups`), `MAX_DB_BACKUPS` (optional, default `14`), `ENABLE_AUTO_BACKUP` (`false` disables daily 03:00 IST cron)
- `SUPPORT_BRAND_NAME`, `SUPPORT_PHONE` (optional) — Contact info shown in account-suspension responses

---

## 5. Automated Backups & Disaster Recovery (`lib/backupService.js`)

### Schedule & CLI
- **Automatic Daily Backup:** Runs every day at **03:00 IST** (unless `ENABLE_AUTO_BACKUP=false`), storing atomic `.json.gz` snapshots + `.meta.json` SHA-256 manifests under `backend/backups/` and keeping the latest `14` snapshots.
- **Manual CLI Backup & Verify:**
  ```bash
  cd backend && npm run backup
  ```
- **SuperAdmin API:**
  - `GET /api/admin/backups` — List available snapshots
  - `POST /api/admin/backups` — Trigger verified snapshot immediately
  - `GET /api/admin/backups/:fileName/download` — Download `.json.gz` offsite copy
  - `POST /api/admin/backups/:fileName/verify` — Verify gzip + SHA-256 integrity
  - `POST /api/admin/backups/:fileName/restore` — Restore snapshot (`clearExisting: true` only with explicit confirmation)

### Disaster Recovery Procedure
1. Ensure healthy `MONGO_URI` target database.
2. Verify latest off-site or local snapshot checksum (`POST /api/admin/backups/<file>/verify`).
3. Execute restore via SuperAdmin API or Node shell (`restoreDatabaseBackup(fileName, { clearExisting: true })`), which verifies SHA-256 before modifying any collection.
4. Keep daily backups copied to external object storage (e.g. S3 / Google Drive / offsite cron sync) in addition to local disk so server loss never destroys snapshots.

