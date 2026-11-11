const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { User, Organization } = require('../models/index');
const cache = require('../lib/cache');
const { resolveRoleAndPermissions } = require('../lib/rbacService');

const AUTH_CACHE_TTL_SEC = 60;
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

/**
 * Single source of truth for JWT signing/verifying secret.
 * Never falls back to a static predictable string.
 */
function getJwtSecret() {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (configured && configured.length >= 16) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET environment variable must be configured (min 16 chars) in production.');
  }
  return configured || EPHEMERAL_DEV_SECRET;
}

function getUserAuthCacheKey(userId) {
  return `auth:user:${userId}`;
}

function getOrgAuthCacheKey(orgId) {
  return `auth:org:${orgId}`;
}

function invalidateUserAuthCache(userId) {
  if (!userId) return;
  cache.del(getUserAuthCacheKey(userId));
}

function invalidateOrgAuthCache(orgId) {
  if (!orgId) return;
  cache.del(getOrgAuthCacheKey(orgId));
}

async function getCachedAuthUser(userId) {
  if (!userId) return null;
  const key = getUserAuthCacheKey(userId);
  const cached = await cache.getAsync(key);
  if (cached) return cached;

  const user = await User.findById(userId)
    .select('_id email username fullName role roleId subRole scopeType scopeValue modules organizationId isActive allowedWards allowedModules permissions casteOptions')
    .lean();

  if (user) {
    cache.set(key, user, AUTH_CACHE_TTL_SEC);
  }
  return user;
}

async function getCachedAuthOrg(orgId) {
  if (!orgId) return null;
  const key = getOrgAuthCacheKey(orgId);
  const cached = await cache.getAsync(key);
  if (cached) return cached;

  const organization = await Organization.findById(orgId)
    .select('_id name isActive enabledModules allowedWards allowedPanchayats wards')
    .lean();

  if (organization) {
    cache.set(key, organization, AUTH_CACHE_TTL_SEC);
  }
  return organization;
}

const verifyToken = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access Denied. No token provided.' });
  }

  let claims;
  try {
    claims = jwt.verify(token, getJwtSecret());
  } catch (err) {
    if (err.message && err.message.startsWith('FATAL:')) {
      console.error(err.message);
      return res.status(500).json({ message: 'Server authentication configuration error.' });
    }
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  try {
    const userId = claims?.user?.id;
    const user = await getCachedAuthUser(userId);
    if (!user) {
      return res.status(401).json({ message: 'Account not found.' });
    }
    if (!user.isActive) {
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'आपका खाता अस्थायी रूप से बंद (निलंबित) किया गया है। कृपया सहायता के लिए संपर्क करें।'
      });
    }

    const organization = await getCachedAuthOrg(user.organizationId);
    if (!organization) {
      return res.status(401).json({ message: 'Organization no longer exists.' });
    }
    if (!organization.isActive) {
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'आपका खाता अस्थायी रूप से बंद (निलंबित) किया गया है। कृपया सहायता के लिए संपर्क करें।'
      });
    }

    const orgModules = organization.enabledModules && organization.enabledModules.length > 0 ? organization.enabledModules : null;
    const workerModules = (Array.isArray(user.modules) && user.modules.length > 0)
      ? user.modules
      : (Array.isArray(user.allowedModules) && user.allowedModules.length > 0 ? user.allowedModules : null);
    const enabledModules = user.role === 'admin'
      ? ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants', 'accounts']
      : user.role === 'worker'
        ? (workerModules
            ? (orgModules ? workerModules.filter((m) => orgModules.includes(m)) : workerModules)
            : (orgModules || ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'migrants']))
        : (orgModules || ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants', 'accounts']);

    let rbacResolved = { roleId: null, roleName: user.role, permissions: [] };
    try {
      rbacResolved = await resolveRoleAndPermissions(user);
    } catch {
      // Non-fatal fallback if RBAC tables are temporarily unreachable
    }

    req.user = {
      id: user._id,
      email: user.email,
      username: user.username || null,
      fullName: user.fullName,
      role: user.role,
      roleId: rbacResolved.roleId,
      rbacRole: rbacResolved.roleName,
      subRole: user.subRole || 'Operator',
      scopeType: user.scopeType || 'All',
      scopeValue: user.scopeValue || null,
      organizationId: user.organizationId,
      allowedWards: (user.role === 'worker' && user.allowedWards && user.allowedWards.length > 0)
        ? user.allowedWards
        : (organization.allowedWards && organization.allowedWards.length > 0 ? organization.allowedWards : []),
      allowedPanchayats: (organization.allowedPanchayats && organization.allowedPanchayats.length > 0)
        ? organization.allowedPanchayats
        : [],
      modules: enabledModules,
      permissions: user.permissions || {},
      permissionsList: rbacResolved.permissions || [],
    };
    return next();
  } catch (err) {
    console.error('verifyToken lookup error:', err.message);
    return res.status(503).json({ message: 'Account permissions could not be verified.' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({ message: 'Access Denied: Admins Only' });
};

const isOrganizationAdmin = (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.role === 'tenant_admin') return next();
  return res.status(403).json({ message: 'Organization administrators only.' });
};

const requireModule = (...allowed) => (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  const granted = Array.isArray(req.user?.modules) ? req.user.modules : [];
  if (!allowed.some((module) => granted.includes(module))) {
    return res.status(403).json({ message: 'Your account does not have access to this module.' });
  }
  if (req.method !== 'GET' && req.user?.subRole === 'Viewer') {
    return res.status(403).json({ message: 'Viewer accounts cannot change records.' });
  }
  return next();
};

const requirePermission = (...requiredPermissions) => (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.rbacRole === 'owner') return next();
  const granted = Array.isArray(req.user?.permissionsList) ? req.user.permissionsList : [];
  const hasAny = requiredPermissions.some((perm) => granted.includes(perm));
  if (!hasAny) {
    return res.status(403).json({
      success: false,
      message: 'इस कार्य के लिए आवश्यक RBAC अनुमति (Permission) उपलब्ध नहीं है।',
      requiredPermissions
    });
  }
  return next();
};

module.exports = {
  verifyToken,
  isAdmin,
  isOrganizationAdmin,
  requireModule,
  requirePermission,
  getJwtSecret,
  invalidateUserAuthCache,
  invalidateOrgAuthCache
};
