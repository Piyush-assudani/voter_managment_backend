const { Role, Permission, RolePermission } = require('../models/rbac');
const { User } = require('../models');
const cache = require('./cache');

const RBAC_CACHE_PREFIX = 'rbac:';
const RBAC_CACHE_TTL_SEC = 120;

const DEFAULT_PERMISSIONS = [
  { key: 'create_order', resource: 'orders', action: 'create', description: 'Create dispatch orders / WhatsApp jobs' },
  { key: 'view_billing', resource: 'billing', action: 'read', description: 'View WhatsApp credits & quota usage' },
  { key: 'delete_user', resource: 'users', action: 'delete', description: 'Delete or deactivate user accounts' },
  { key: 'voters:read', resource: 'voters', action: 'read', description: 'View & search voter directory' },
  { key: 'voters:write', resource: 'voters', action: 'write', description: 'Update voter phones, caste, status, and turnout' },
  { key: 'voters:export', resource: 'voters', action: 'export', description: 'Export voter Excel / CSV sheets' },
  { key: 'slips:send', resource: 'slips', action: 'send', description: 'Send WhatsApp digital voter slips' },
  { key: 'workers:manage', resource: 'workers', action: 'manage', description: 'Create, edit & manage field workers' },
  { key: 'analytics:view', resource: 'analytics', action: 'read', description: 'Access War Room & community analytics' },
  { key: 'backups:manage', resource: 'backups', action: 'manage', description: 'Trigger, download & restore DB backups' },
  { key: 'errors:view', resource: 'errors', action: 'read', description: 'Inspect structured backend error telemetry' },
  { key: 'rbac:manage', resource: 'rbac', action: 'manage', description: 'Configure roles & permission matrix' },
];

const DEFAULT_ROLES = [
  {
    _id: 'role_owner',
    name: 'owner',
    displayName: 'Owner (Platform Master)',
    aliases: ['admin', 'superadmin'],
    description: 'Full platform ownership across organizations, billing, backups, error logs, and RBAC.',
    permissions: DEFAULT_PERMISSIONS.map((p) => p.key),
  },
  {
    _id: 'role_manager',
    name: 'manager',
    displayName: 'Manager (Organization Admin)',
    aliases: ['tenant_admin'],
    description: 'Campaign manager with full voter operations, team management, billing view, and dispatch orders.',
    permissions: [
      'create_order',
      'view_billing',
      'delete_user',
      'voters:read',
      'voters:write',
      'voters:export',
      'slips:send',
      'workers:manage',
      'analytics:view',
    ],
  },
  {
    _id: 'role_clerk',
    name: 'clerk',
    displayName: 'Clerk (Field Operator / Karyakarta)',
    aliases: ['worker', 'operator', 'booth_agent'],
    description: 'Field desk & voter outreach operator scoped to assigned wards and modules.',
    permissions: ['create_order', 'voters:read', 'voters:write', 'slips:send', 'analytics:view'],
  },
  {
    _id: 'role_teacher',
    name: 'teacher',
    displayName: 'Teacher (Read-Only Analyst / Viewer)',
    aliases: ['viewer'],
    description: 'Read-only observer who can review voter lists and analytics without modifying records.',
    permissions: ['voters:read', 'analytics:view'],
  },
];

let seedPromise = null;

/**
 * Idempotently seed Roles, Permissions, and Role_Permissions in MongoDB.
 */
async function ensureDefaultRbacSeeded() {
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    const permOps = DEFAULT_PERMISSIONS.map((p) => ({
      updateOne: {
        filter: { key: p.key },
        update: {
          $setOnInsert: {
            _id: `perm_${p.key.replace(/[^a-z0-9]/g, '_')}`,
            key: p.key,
            resource: p.resource,
            action: p.action,
            description: p.description,
          },
        },
        upsert: true,
      },
    }));
    await Permission.bulkWrite(permOps, { ordered: false });

    const allPerms = await Permission.find({}).lean();
    const permByKey = new Map(allPerms.map((p) => [p.key, p]));

    for (const roleDef of DEFAULT_ROLES) {
      await Role.updateOne(
        { _id: roleDef._id },
        {
          $setOnInsert: {
            _id: roleDef._id,
            name: roleDef.name,
            displayName: roleDef.displayName,
            aliases: roleDef.aliases,
            description: roleDef.description,
            isSystem: true,
          },
        },
        { upsert: true }
      );

      const existingCount = await RolePermission.countDocuments({ roleId: roleDef._id });
      if (existingCount === 0) {
        const links = roleDef.permissions
          .map((key) => permByKey.get(key))
          .filter(Boolean)
          .map((perm) => ({
            _id: `rp_${roleDef.name}_${perm.key.replace(/[^a-z0-9]/g, '_')}`,
            roleId: roleDef._id,
            permissionId: perm._id,
            grantedBy: 'system_seed',
          }));
        if (links.length > 0) {
          await RolePermission.insertMany(links, { ordered: false }).catch(() => {});
        }
      }
    }
  })().catch((err) => {
    seedPromise = null;
    throw err;
  });

  return seedPromise;
}

function invalidateRbacCache() {
  cache.delPrefix(RBAC_CACHE_PREFIX);
}

/**
 * Resolve role name / alias / roleId into canonical role + permission key list (L1+L2 cached).
 */
async function resolveRoleAndPermissions(userOrRoleInput) {
  const roleId = typeof userOrRoleInput === 'object' ? userOrRoleInput?.roleId : null;
  const rawRole = typeof userOrRoleInput === 'object' ? userOrRoleInput?.role : userOrRoleInput;
  const subRole = typeof userOrRoleInput === 'object' ? userOrRoleInput?.subRole : null;

  const lookupSlug = subRole === 'Viewer'
    ? 'viewer'
    : String(roleId || rawRole || 'clerk').trim().toLowerCase();

  const cacheKey = `${RBAC_CACHE_PREFIX}resolved:${lookupSlug}`;
  const cached = await cache.getAsync(cacheKey);
  if (cached) return cached;

  await ensureDefaultRbacSeeded();

  let role = await Role.findOne({
    $or: [
      { _id: lookupSlug },
      { name: lookupSlug },
      { aliases: lookupSlug },
    ],
  }).lean();

  if (!role) {
    role = await Role.findOne({ name: 'clerk' }).lean();
  }

  if (!role) {
    return { roleId: null, roleName: lookupSlug, permissions: [] };
  }

  const joins = await RolePermission.find({ roleId: role._id }).select('permissionId').lean();
  const permIds = joins.map((j) => j.permissionId);
  const perms = permIds.length > 0
    ? await Permission.find({ _id: { $in: permIds } }).select('key').lean()
    : [];

  const result = {
    roleId: role._id,
    roleName: role.name,
    displayName: role.displayName,
    permissions: perms.map((p) => p.key),
  };

  cache.set(cacheKey, result, RBAC_CACHE_TTL_SEC);
  return result;
}

async function grantPermissionToRole(roleIdOrName, permissionKey, actorId = 'admin') {
  await ensureDefaultRbacSeeded();
  const role = await Role.findOne({
    $or: [{ _id: roleIdOrName }, { name: String(roleIdOrName).toLowerCase() }],
  }).lean();
  const perm = await Permission.findOne({ key: String(permissionKey).toLowerCase().trim() }).lean();
  if (!role || !perm) {
    return { ok: false, message: 'Role or Permission not found.' };
  }

  await RolePermission.updateOne(
    { roleId: role._id, permissionId: perm._id },
    {
      $setOnInsert: {
        _id: `rp_${role.name}_${perm.key.replace(/[^a-z0-9]/g, '_')}`,
        roleId: role._id,
        permissionId: perm._id,
        grantedBy: actorId,
      },
    },
    { upsert: true }
  );

  invalidateRbacCache();
  return { ok: true, roleId: role._id, permission: perm.key };
}

async function revokePermissionFromRole(roleIdOrName, permissionKey) {
  await ensureDefaultRbacSeeded();
  const role = await Role.findOne({
    $or: [{ _id: roleIdOrName }, { name: String(roleIdOrName).toLowerCase() }],
  }).lean();
  const perm = await Permission.findOne({ key: String(permissionKey).toLowerCase().trim() }).lean();
  if (!role || !perm) {
    return { ok: false, message: 'Role or Permission not found.' };
  }

  await RolePermission.deleteOne({ roleId: role._id, permissionId: perm._id });
  invalidateRbacCache();
  return { ok: true, roleId: role._id, permission: perm.key };
}

async function assignRoleToUser(userId, roleIdOrName) {
  await ensureDefaultRbacSeeded();
  const role = await Role.findOne({
    $or: [{ _id: roleIdOrName }, { name: String(roleIdOrName).toLowerCase() }, { aliases: String(roleIdOrName).toLowerCase() }],
  }).lean();
  if (!role) return { ok: false, message: 'Role not found.' };

  const legacyRoleMap = {
    owner: 'admin',
    manager: 'tenant_admin',
    clerk: 'worker',
    teacher: 'worker',
  };

  const update = {
    roleId: role._id,
    role: legacyRoleMap[role.name] || 'worker',
    ...(role.name === 'teacher' ? { subRole: 'Viewer' } : {}),
  };

  const user = await User.findByIdAndUpdate(userId, { $set: update }, { returnDocument: 'after' }).lean();
  if (!user) return { ok: false, message: 'User not found.' };

  cache.del(`auth:user:${userId}`);
  invalidateRbacCache();
  return { ok: true, userId: user._id, roleId: role._id, roleName: role.name };
}

async function getRbacMatrix() {
  await ensureDefaultRbacSeeded();
  const [roles, permissions, links] = await Promise.all([
    Role.find({}).sort({ name: 1 }).lean(),
    Permission.find({}).sort({ resource: 1, key: 1 }).lean(),
    RolePermission.find({}).lean(),
  ]);

  const permById = new Map(permissions.map((p) => [p._id, p.key]));
  const rolePermMap = new Map();
  for (const link of links) {
    if (!rolePermMap.has(link.roleId)) rolePermMap.set(link.roleId, []);
    const key = permById.get(link.permissionId);
    if (key) rolePermMap.get(link.roleId).push(key);
  }

  return {
    roles: roles.map((r) => ({ ...r, permissions: rolePermMap.get(r._id) || [] })),
    permissions,
    rolePermissions: links,
  };
}

module.exports = {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLES,
  ensureDefaultRbacSeeded,
  resolveRoleAndPermissions,
  grantPermissionToRole,
  revokePermissionFromRole,
  assignRoleToUser,
  getRbacMatrix,
  invalidateRbacCache,
};

