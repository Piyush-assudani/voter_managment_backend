/**
 * Private client organizations.
 *
 * An organization whose `settings.privateAdminIds` is a non-empty array is hidden from
 * every platform admin (role 'admin') whose user id is not in that list: it does not
 * appear in client lists, counts, dashboards or "all clients" voter queries, and any
 * request that targets it directly is refused. Tenant users of that organization are
 * unaffected (they are always confined to their own organization).
 */
const mongoose = require('mongoose');

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, map: new Map() }; // orgId -> Set(allowed admin user ids)

async function loadPrivateOrgs() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const Organization = mongoose.model('Organization');
  const orgs = await Organization.find(
    { 'settings.privateAdminIds.0': { $exists: true } },
    { 'settings.privateAdminIds': 1 }
  ).lean();
  const map = new Map();
  for (const o of orgs) map.set(String(o._id), new Set((o.settings.privateAdminIds || []).map(String)));
  cache = { at: Date.now(), map };
  return map;
}

function invalidatePrivateOrgCache() {
  cache = { at: 0, map: new Map() };
}

/** Org ids this user must not see. Only platform admins can ever have hidden orgs. */
async function getHiddenOrgIds(user) {
  if (!user || user.role !== 'admin') return [];
  const map = await loadPrivateOrgs();
  const hidden = [];
  for (const [orgId, allowed] of map) {
    if (!allowed.has(String(user.id))) hidden.push(orgId);
  }
  return hidden;
}

/** Ids a request may be targeting (headers, query, body, route param). */
function requestedOrgIds(req) {
  const ids = [
    req.headers?.['x-organization-id'],
    req.headers?.['x-client-id'],
    req.query?.organizationId,
    req.query?.orgId,
    req.body?.organizationId,
    req.params?.id,
    req.params?.orgId,
  ];
  return ids.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

/** Mongo filter fragment that excludes hidden orgs, or null when nothing is hidden. */
function hiddenOrgFilter(req) {
  const hidden = req.user?.hiddenOrgIds || [];
  return hidden.length ? { $nin: hidden } : null;
}

/** Short cache-key suffix so cached "all clients" responses are not shared across admins. */
function visibilityKey(req) {
  const hidden = req.user?.hiddenOrgIds || [];
  return hidden.length ? `_h${hidden.slice().sort().join('.')}` : '';
}

module.exports = {
  getHiddenOrgIds,
  requestedOrgIds,
  hiddenOrgFilter,
  visibilityKey,
  invalidatePrivateOrgCache,
};
