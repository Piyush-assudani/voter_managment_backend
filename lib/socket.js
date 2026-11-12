const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../middleware/authMiddleware');
const logger = require('./logger');

let io = null;

function sanitizeOrgId(orgId) {
  if (typeof orgId !== 'string') return '';
  const cleaned = orgId.trim();
  if (!cleaned || cleaned.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return '';
  }
  return cleaned;
}

/**
 * Initialize Socket.IO on the shared HTTP server with strict JWT & tenant room isolation.
 */
function initSocket(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
  });

  io.use((socket, next) => {
    try {
      const authHeader = socket.handshake.headers?.authorization || '';
      const rawToken =
        socket.handshake.auth?.token ||
        (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');

      if (!rawToken) {
        return next(new Error('Authentication token required'));
      }

      const decoded = jwt.verify(rawToken, getJwtSecret());
      if (!decoded || !decoded.id) {
        return next(new Error('Invalid authentication token'));
      }

      socket.user = decoded;
      return next();
    } catch {
      return next(new Error('Unauthorized WebSocket connection'));
    }
  });

  io.on('connection', (socket) => {
    const userOrgId = sanitizeOrgId(socket.user?.organizationId) || 'org_default';
    let activeRoom = `org:${userOrgId}`;
    socket.join(activeRoom);

    // Superadmins switching between client organizations can switch room cleanly
    const requestedOrgId = sanitizeOrgId(socket.handshake.auth?.organizationId);
    if (socket.user?.role === 'admin' && requestedOrgId && requestedOrgId !== userOrgId) {
      socket.leave(activeRoom);
      activeRoom = `org:${requestedOrgId}`;
      socket.join(activeRoom);
    }

    socket.on('join-org', (orgId) => {
      if (socket.user?.role !== 'admin') return;
      const targetOrgId = sanitizeOrgId(orgId) || userOrgId;
      const nextRoom = `org:${targetOrgId}`;
      if (nextRoom !== activeRoom) {
        socket.leave(activeRoom);
        activeRoom = nextRoom;
        socket.join(activeRoom);
      }
    });

    socket.on('error', (err) => {
      logger.warn('Socket client error', { error: err?.message });
    });
  });

  logger.info('Socket.IO real-time server initialized');
  return io;
}

/**
 * Broadcast a tenant-scoped real-time event. Safe no-op when running in unit tests without HTTP server.
 */
function emitOrgEvent(organizationId, eventName, payload) {
  if (!io || !eventName) return;
  const targetOrg = sanitizeOrgId(organizationId) || 'org_default';
  io.to(`org:${targetOrg}`).emit(eventName, {
    ...payload,
    organizationId: targetOrg,
    ts: Date.now(),
  });
}

function closeSocket() {
  if (!io) return;
  try {
    io.close();
  } catch {
    // ignore close errors during shutdown
  }
  io = null;
}

module.exports = {
  initSocket,
  emitOrgEvent,
  closeSocket,
};

