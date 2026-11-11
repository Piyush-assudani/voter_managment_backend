const mongoose = require('mongoose');

/**
 * Normalized RBAC Tables:
 *  - Role (`roles`): Owner, Manager, Clerk, Teacher (+ VijaySetu aliases admin, tenant_admin, worker, viewer)
 *  - Permission (`permissions`): granular capability keys (create_order, view_billing, delete_user, voters:write, ...)
 *  - RolePermission (`role_permissions`): many-to-many join table with compound unique constraint
 */

const roleSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'role_owner', 'role_manager', 'role_clerk', 'role_teacher'
  name: { type: String, required: true, unique: true, lowercase: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  aliases: { type: [String], default: [], index: true }, // Maps domain role slugs seamlessly (e.g. 'admin' -> 'owner')
  description: { type: String, default: '' },
  isSystem: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const permissionSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'perm_create_order'
  key: { type: String, required: true, unique: true, lowercase: true, trim: true },
  resource: { type: String, required: true, trim: true, index: true },
  action: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

const rolePermissionSchema = new mongoose.Schema({
  _id: { type: String, default: () => `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` },
  roleId: { type: String, required: true, ref: 'Role', index: true },
  permissionId: { type: String, required: true, ref: 'Permission', index: true },
  grantedAt: { type: Date, default: Date.now },
  grantedBy: { type: String, default: 'system' },
});

rolePermissionSchema.index({ roleId: 1, permissionId: 1 }, { unique: true });

const Role = mongoose.models.Role || mongoose.model('Role', roleSchema);
const Permission = mongoose.models.Permission || mongoose.model('Permission', permissionSchema);
const RolePermission = mongoose.models.RolePermission || mongoose.model('RolePermission', rolePermissionSchema);

module.exports = {
  Role,
  Permission,
  RolePermission,
};

