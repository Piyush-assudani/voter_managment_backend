# VijaySetu — Product Requirements Document (PRD)

## 1. Product Vision
**VijaySetu** is a multi-tenant election booth & voter management platform engineered for high-concurrency field campaigns (web, PWA/mobile browser, and Android WebView wrapper). It equips candidates, booth managers, and field karyakartas to manage digitized electoral rolls, generate multilingual campaign voter slips, coordinate family-level outreach, track real-time booth turnout even in spotty polling-booth networks, and operate WhatsApp slip dispatch safely under strict cost and privacy guardrails.

---

## 2. Target Personas & Normalized RBAC Mapping
| Persona | Legacy Role | Normalized RBAC Role (`Role.key`) | Core Capabilities |
|---|---|---|---|
| **Platform Owner / SuperAdmin** | `admin` | `owner` | Cross-tenant provisioning, suspension controls, database backup/restore, error diagnostics, outbound circuit-breaker monitoring, global RBAC matrix administration |
| **Campaign Manager** | `tenant_admin` | `manager` | Ward/booth voter CRUD, bulk import/export, worker account & ward assignment, digital slip template designer, WhatsApp credit topup & dispatch, campaign analytics & turnout dashboards |
| **Booth Clerk / Field Worker** | `worker` | `clerk` | Ward-scoped voter search, family view, offline-first poll-desk marking, turnout marking, WhatsApp slip dispatch, migrant/community tags |
| **Observer / Analyst** | `viewer` | `teacher` | Read-only access to assigned analytics, turnout summaries, and voter records |

*(All role permissions are resolved from normalized collections: `Users` -> `Roles` <- `Role_Permissions` -> `Permissions`.)*

---

## 3. Core Functional Modules
1. **Multi-Tenant Authentication & Access Control**
   - Stateless JWT authentication with server-side subscription expiry, active-user gating, and organization module licensing (`voters`, `poll-desk`, `turnout`, `warroom`, `history`, `community`, `workers`, `migrants`, `accounts`).
   - Configurable RBAC matrix allowing SuperAdmins (`owner`) to grant or revoke discrete permissions per role (`create_order`, `view_billing`, `delete_user`, `voters:read`, `voters:write`, `voters:import`, `slips:send`, `workers:manage`, `analytics:view`, `backups:manage`, `errors:view`, `rbac:manage`).
2. **Digital Voter Directory & Family Intelligence (`voters`)**
   - Bilingual Hindi/English roll normalization with Devanagari OCR glyph repair (`lib/glyphNormalizer.js`), compound multi-tenant search indexes, ward/part filters, custom tags, and household/family clustering (`lib/familyService.js`).
3. **Offline-First Poll Desk & Booth Turnout (`poll-desk`, `turnout`)**
   - IndexedDB voter cache capped at 2,000 slim records per organization to prevent memory pressure on 1GB–2GB Android devices.
   - Offline mutation outbox queues vote updates when polling booths lose cellular signal and automatically replays them with preserved `Idempotency-Key` headers and exponential backoff upon reconnection.
4. **Digital Slip Studio & WhatsApp Dispatch (`slips`, `whatsapp`)**
   - Dynamic slip designer with editable EVM serial number, party symbol, candidate banner, bilingual voter details, and WhatsApp dispatch protected by atomic credit deduction and outbound Meta API circuit breakers.
5. **War Room, Analytics, Community & Migrant Tracking**
   - Single-pass `$facet` / `$group` server aggregations across ward turnout, caste/community outreach, and out-of-station migrant follow-up without full collection scans.
6. **Reliability, Observability & Disaster Recovery**
   - Structured PII-redacted `ErrorLog` tracking (30-day TTL), gzipped SHA-256 checksummed backups, automated restore verification, and `/api/meta/version` client compatibility handshake.

---

## 4. Non-Functional Requirements
- **Zero-Crash Mobile Experience:** iOS/Android notch/cutout safe-area padding, virtual keyboard viewport resizing (`interactiveWidget: 'resizes-content'`), background pause/resume recovery, and client schema cache migration (`APP_SCHEMA_VERSION`).
- **Zero-Trust Security:** Server-enforced tenant isolation (`req.user.organizationId`), prototype/NoSQL operator sanitization, bounded TTL IP auto-banning on scanner probes, and webhook HMAC-SHA256 verification.
- **Cost & Free-Tier Discipline:** Outbound Meta WhatsApp & free-tier LLM fallbacks (OpenRouter, Groq, Cloudinary) enforce daily budget caps, exponential backoff, and circuit breakers.
- **Data Privacy & Compliance:** Consent preferences, PII redaction in error logs, data export/deletion endpoints, and clear Play Store / App Store compliant security posture (HTTPS-only WebView, scoped media permissions).

