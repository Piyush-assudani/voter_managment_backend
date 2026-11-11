# VijaySetu — Technical Reference Document (TRD)

## 1. Technology Stack
| Layer | Technology |
|---|---|
| **Backend Runtime & API** | Node.js 20+, Express 5, Mongoose 9 (MongoDB), Zod/Joi validation |
| **Caching & Cross-Node Sync** | In-process L1 LRU (`cache.js`) + optional Redis L2 & Pub/Sub invalidation (`ioredis`) |
| **Frontend Web App & PWA** | Next.js 16 (App Router, React 19, TypeScript, Tailwind CSS), IndexedDB (`offlineSync.ts`) |
| **Android Wrapper** | Kotlin `AppCompatActivity` + hardened `WebView` (`AndroidManifest.xml`, `MainActivity.kt`) |
| **External Integrations** | Meta WhatsApp Cloud API, Cloudinary media upload, OpenRouter & Groq free-tier OCR fallbacks |
| **CI/CD** | GitHub Actions (`ci-cd.yml`) with secret gate, syntax/type checks, isolated `MongoMemoryServer` tests |

---

## 2. Stateless Horizontal Scaling Architecture
VijaySetu backend instances store **no sticky session state in memory**:
- **JWT Authentication:** Every API request carries a signed `Authorization: Bearer <token>` JWT verified statelessly by `middleware/authMiddleware.js`.
- **Distributed Cache Consistency:** `lib/cache.js` pairs fast local L1 TTL caches with optional Redis (`REDIS_URL`). Calling `cache.del()`, `cache.delPrefix()`, `invalidateUserAuthCache()`, or `invalidateOrgAuthCache()` publishes an invalidation event onto Redis Pub/Sub channel `vijaysetu:cache_invalidate` so Peer Server A/B/C immediately evict stale local L1 auth/org entries.
- **Externalized Cron Control:** Automated DB backups run only when `ENABLE_AUTO_BACKUP !== 'false'`, allowing multi-replica clusters to nominate a single backup runner (e.g., primary worker or external scheduler).
- **Database Connection Pooling:** `db.js` configures bounded Mongoose pools (`maxPoolSize`, `minPoolSize`, `serverSelectionTimeoutMS`, `socketTimeoutMS`) suitable for horizontal replicas without exhausting Atlas connections.

---

## 3. Normalized RBAC Database Design (`models/rbac.js`, `lib/rbacService.js`)
Four linked collections enforce granular authorization without breaking legacy tenant roles:
1. **`users` (`User`):** Stores `organizationId`, `role` (`admin`, `tenant_admin`, `worker`, `viewer`), and `roleId` referencing `Role._id`.
2. **`roles` (`Role`):** Unique normalized keys:
   - `owner` (aliases `admin`, `owner`)
   - `manager` (aliases `tenant_admin`, `manager`)
   - `clerk` (aliases `worker`, `clerk`)
   - `teacher` (aliases `viewer`, `teacher`)
3. **`permissions` (`Permission`):** Catalog of permission keys including `create_order`, `view_billing`, `delete_user`, `voters:read`, `voters:write`, `voters:import`, `slips:send`, `workers:manage`, `analytics:view`, `backups:manage`, `errors:view`, and `rbac:manage`.
4. **`role_permissions` (`RolePermission`):** Join collection with unique compound index `{ roleId: 1, permissionId: 1 }`.

`verifyToken` attaches `req.user.rbacRole` and `req.user.permissionsList` (60s cached via `cache.js`), and routes can guard actions with `requirePermission('create_order', ...)`. SuperAdmins administer the live matrix via `/api/rbac/matrix`, `POST /api/rbac/roles/:roleId/permissions`, `DELETE /api/rbac/roles/:roleId/permissions/:permissionKey`, and `PUT /api/rbac/users/:userId/role`.

---

## 4. Database Indexing, Cost Control & Concurrency
- **Tenant-Leading Compound Indexes:** All hot `Voter` indexes start with `organizationId` (plus `wardNo`, `partNo`, `serialNo`, `epic`, `familyId`, `voted`, `caste`, `supportStatus`). Redundant single-field prefix indexes are omitted to cut write IOPS and RAM footprint.
- **No Unindexed Collations:** Queries avoid `.collation({ locale: 'en' })` on sorts lacking collated indexes, preventing full-collection in-memory sorts.
- **Single-Pass Aggregations:** Dashboard summaries (`/wards-summary`, `/panchayats-summary`, `/issues-summary`) use single-pass `$facet` / `$group` stages instead of redundant sequential DB queries.
- **1,000-Concurrent-Click Protection:**
  - `middleware/idempotencyMiddleware.js` serializes duplicate concurrent `Idempotency-Key` requests using an in-flight mutex and response replay map keyed by `(actorScope, method, path, idempotencyKey)`.
  - WhatsApp credit consumption and daily limits use atomic conditional `findOneAndUpdate({ creditsBalance: { $gte: cost } }, { $inc: { creditsBalance: -cost } })` transactions so parallel clicks can never overspend credits or go negative.
  - Worker cap enforcement in `POST /api/users` uses post-insert verification + deterministic rollback sorting (`{ createdAt: 1, _id: 1 }`).

---

## 5. Outbound Resilience, Backoff, Circuit Breakers & Free-Tier Budgets (`lib/outboundService.js`)
Every outbound third-party service (`whatsapp_meta`, `cloudinary`, `openrouter`, `groq`) passes through `executeWithResilience()`:
1. **Concurrency Semaphore:** Limits concurrent in-flight outbound sockets per provider to avoid event-loop saturation and rate-limit storms.
2. **Daily Free-Tier Budget Guard:** Counts daily calls per provider (`META_DAILY_CAP`, `CLOUDINARY_DAILY_CAP`, `LLM_DAILY_CAP`); throws `BUDGET_EXCEEDED` (HTTP 429) before exceeding quotas or generating runaway API bills.
3. **Circuit Breaker:** Trips to `OPEN` after consecutive upstream failures (`5` default) for a cooldown window (`45s`–`90s`), transitioning to `HALF_OPEN` for probe recovery rather than piling timeouts onto a dead API.
4. **Exponential Backoff with Full Jitter:** Retries transient `429` / `5xx` / network errors with jittered delays while short-circuiting non-retryable `4xx` errors immediately.

---

## 6. Offline-First Sync, Low-End Device Caps & Versioning (`frontend/src/lib/offlineSync.ts`)
- **IndexedDB Storage (`vijaysetu_offline_db`):**
  - `cachedVoters` stores slim `CachedVoterCompact` projections capped at **2,000 records** per app instance to fit comfortably within low-end 1GB–2GB Android RAM budgets.
  - `pendingMutations` queues booth vote updates (`PUT /api/voters/:id/vote`) when `navigator.onLine === false` or during transient 502/503/504 outages via `resilientMutate()`.
- **Auto-Sync & Backoff:** `AppResilienceProvider` triggers `flushOfflineQueue()` when the browser emits `online`, returns from background (`visibilitychange`), or restores from BFCache (`pageshow`).
- **Schema Version Safety:** `APP_SCHEMA_VERSION` (`2026.1.2`) detects incompatible pre-upgrade caches in `localStorage` and clears stale IndexedDB voter subsets cleanly while **preserving** the user's JWT token and unsent outbox mutations. `/api/meta/version` advertises backend `minClientVersion`.

---

## 7. Timezones, Physical Device & Play Store Hardening
- **UTC Everywhere + Localized Display (`dateUtils.js` / `dateUtils.ts`):** MongoDB persists timestamps in UTC; queries convert IANA client timezones (`X-Client-Timezone` header, defaulting to `Asia/Kolkata`) into exact UTC day boundaries via `Intl.DateTimeFormat`, safely supporting DST and UTC offsets.
- **Physical Device UX (`layout.tsx`, `globals.css`, `DashboardShell.tsx`):**
  - `viewport`: `interactiveWidget: 'resizes-content'`, accessible `userScalable: true`, `maximumScale: 5`, `100dvh` layout, CSS `env(safe-area-inset-*)` notch/home-bar padding, `--keyboard-inset` tracking via `window.visualViewport`, and automatic `scrollIntoView({ block: 'center' })` on focused inputs.
- **Android Wrapper (`MainActivity.kt`, `AndroidManifest.xml`):**
  - `usesCleartextTraffic="false"` and `MIXED_CONTENT_NEVER_ALLOW` (HTTPS strictly enforced).
  - Scoped `onPermissionRequest` granted only to trusted VijaySetu origins.
  - `ViewCompat.setOnApplyWindowInsetsListener` handles display cutouts and IME height natively.
  - `onSaveInstanceState` / `restoreState`, `onTrimMemory`, and `onRenderProcessGone` prevent crashes after long background minimization or low-memory kills.

---

## 8. Error Tracker, Security & Non-Blocking Backups
- **Error Tracker (`lib/errorTracker.js`, `models/index.js`):** Captures unhandled 5xx exceptions and `unhandledRejection` events, normalizes messages/stacks into SHA-256 fingerprints (`occurrences` increment on duplicates), redacts secrets/JWTs/passwords/mobile numbers, and expires records automatically via a 30-day MongoDB TTL index. Queryable at `GET /api/admin/errors`.
- **Non-Blocking Async Backups (`lib/backupService.js`):** Uses `zlib.gzip` / `zlib.gunzip` callbacks wrapped in promises + `fs.promises` for `.json.gz` snapshots and SHA-256 manifests (`meta.sha256`), refusing corrupt restores before mutating collections.
- **Edge Security (`securityMiddleware.js`):** Keeps permissive CORS (`Access-Control-Allow-Origin: *`) for web/mobile compatibility while enforcing Helmet headers, scanner probe trapping (`/.env`, `/wp-login.php`, `/.git/*` -> temporary IP block), tiered rate limits, NoSQL/prototype pollution stripping, and ZIP bomb decompression guards.

