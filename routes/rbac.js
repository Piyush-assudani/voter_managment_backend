const express = require('express');
const { verifyToken, requirePermission } = require('../middleware/authMiddleware');
const {
  getRbacMatrix,
  grantPermissionToRole,
  revokePermissionFromRole,
  assignRoleToUser,
} = require('../lib/rbacService');

const router = express.Router();

router.use(verifyToken);

/**
 * GET /api/rbac/my-permissions
 * Returns the caller's resolved role + effective normalized permission keys.
 */
router.get('/my-permissions', (req, res) => {
  res.json({
    role: req.user.role,
    rbacRole: req.user.rbacRole || req.user.role,
    permissions: req.user.permissionsList || [],
  });
});

/**
 * GET /api/rbac/matrix
 * Full Roles, Permissions, and Role_Permissions mapping (Owner / rbac:manage).
 */
router.get('/matrix', requirePermission('rbac:manage'), async (_req, res) => {
  try {
    const matrix = await getRbacMatrix();
    res.json(matrix);
  } catch (err) {
    console.error('RBAC matrix error:', err.message);
    res.status(500).json({ message: 'Could not load RBAC matrix.' });
  }
});

/**
 * POST /api/rbac/roles/:roleId/permissions
 */
router.post('/roles/:roleId/permissions', requirePermission('rbac:manage'), async (req, res) => {
  try {
    const { permissionKey } = req.body || {};
    if (!permissionKey || typeof permissionKey !== 'string') {
      return res.status(400).json({ message: 'permissionKey is required.' });
    }
    const result = await grantPermissionToRole(req.params.roleId, permissionKey, req.user.id);
    if (!result.ok) return res.status(404).json({ message: result.message });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to assign permission.' });
  }
});

/**
 * DELETE /api/rbac/roles/:roleId/permissions/:permissionKey
 */
router.delete('/roles/:roleId/permissions/:permissionKey', requirePermission('rbac:manage'), async (req, res) => {
  try {
    const result = await revokePermissionFromRole(req.params.roleId, req.params.permissionKey);
    if (!result.ok) return res.status(404).json({ message: result.message });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to revoke permission.' });
  }
});

/**
 * PUT /api/rbac/users/:userId/role
 */
router.put('/users/:userId/role', requirePermission('rbac:manage'), async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!role || typeof role !== 'string') {
      return res.status(400).json({ message: 'role is required.' });
    }
    const result = await assignRoleToUser(req.params.userId, role);
    if (!result.ok) return res.status(404).json({ message: result.message });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to assign role to user.' });
  }
});

module.exports = router;

