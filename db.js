const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Organization, User } = require('./models/index');

let inMemoryServer = null;

/**
 * Bootstrap core organizations / initial admins strictly from environment variables.
 * Never overwrites existing passwords on restart, and never seeds predictable hardcoded passwords.
 */
const ensureSchema = async () => {
  try {
    const defaultOrgId = 'org_default';
    const existingOrgCount = await Organization.countDocuments();
    if (existingOrgCount === 0) {
      await Organization.create({
        _id: defaultOrgId,
        name: 'विजयसेतु मुख्य संगठन (System Root)',
        isActive: true,
        enabledModules: ['voters', 'poll-desk', 'turnout', 'warroom', 'history', 'community', 'workers', 'migrants', 'accounts']
      });
    }

    const masterOrg = await Organization.findById(defaultOrgId) || await Organization.findOne();
    const orgId = masterOrg ? masterOrg._id : defaultOrgId;

    // Optional Master Admin bootstrap ONLY when env vars explicitly set
    const masterUser = (process.env.MASTER_ADMIN_USERNAME || '').trim();
    const masterPass = (process.env.MASTER_ADMIN_PASSWORD || '').trim();
    const masterEmail = (process.env.MASTER_ADMIN_EMAIL || 'master@vijaysetu.local').trim().toLowerCase();
    if (masterUser && masterPass) {
      const existingMaster = await User.findOne({ $or: [{ username: masterUser }, { email: masterEmail }] });
      if (!existingMaster) {
        const masterPassHash = await bcrypt.hash(masterPass, 10);
        await User.create({
          _id: `admin_master_${Date.now()}`,
          username: masterUser,
          email: masterEmail,
          passwordHash: masterPassHash,
          fullName: 'VijaySetu Master Admin',
          phone: (process.env.MASTER_ADMIN_PHONE || '').trim(),
          role: 'admin',
          organizationId: orgId,
          isActive: true
        });
        console.log(`✅ Master Admin created cleanly from env: ${masterUser}`);
      } else if (process.env.BOOTSTRAP_FORCE_RESET === 'true') {
        existingMaster.passwordHash = await bcrypt.hash(masterPass, 10);
        existingMaster.role = 'admin';
        existingMaster.isActive = true;
        await existingMaster.save();
        console.log(`🔄 Master Admin password reset via BOOTSTRAP_FORCE_RESET for: ${masterUser}`);
      }
    }

    // Optional Bootstrap Admin (e.g. primary SuperAdmin) ONLY when env credentials are provided
    const adminEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = (process.env.BOOTSTRAP_ADMIN_PASSWORD || '').trim();
    if (adminEmail && adminPassword) {
      const existingAdmin = await User.findOne({ email: adminEmail });
      if (!existingAdmin) {
        const passHash = await bcrypt.hash(adminPassword, 10);
        await User.create({
          _id: `admin_bootstrap_${Date.now()}`,
          email: adminEmail,
          passwordHash: passHash,
          fullName: (process.env.BOOTSTRAP_ADMIN_NAME || 'System Administrator').trim(),
          phone: (process.env.BOOTSTRAP_ADMIN_PHONE || '').trim(),
          role: 'admin',
          organizationId: orgId,
          isActive: true
        });
        console.log(`✅ Bootstrap Admin created cleanly from env: ${adminEmail}`);
      }
    }

    // Optional Second Admin from env vars
    const secondAdminUser = (process.env.SECOND_ADMIN_USERNAME || '').trim();
    const secondAdminPass = (process.env.SECOND_ADMIN_PASSWORD || '').trim();
    if (secondAdminUser && secondAdminPass) {
      const secondAdminEmail = (process.env.SECOND_ADMIN_EMAIL || `${secondAdminUser.toLowerCase()}@vijaysetu.local`).trim().toLowerCase();
      const existingSecond = await User.findOne({ $or: [{ username: secondAdminUser }, { email: secondAdminEmail }] });
      if (!existingSecond) {
        const secondPassHash = await bcrypt.hash(secondAdminPass, 10);
        await User.create({
          _id: `admin_${secondAdminUser.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          username: secondAdminUser,
          email: secondAdminEmail,
          passwordHash: secondPassHash,
          fullName: (process.env.SECOND_ADMIN_FULL_NAME || secondAdminUser).trim(),
          phone: (process.env.SECOND_ADMIN_PHONE || '').trim(),
          role: 'admin',
          organizationId: orgId,
          isActive: true
        });
        console.log(`✅ Secondary Admin created cleanly from env: ${secondAdminUser}`);
      }
    }
  } catch (err) {
    console.error('❌ Schema / bootstrap init error:', err.message);
  }
};

const connectDB = async () => {
  const configuredUri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  const isProd = process.env.NODE_ENV === 'production';
  const allowInMemory = process.env.ALLOW_INMEMORY_DB === 'true' || (!isProd && !configuredUri);

  // Never silently downgrade to an empty ephemeral MongoMemoryServer when an external DB URI is configured!
  if (configuredUri) {
    const sanitizedUri = configuredUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
    await mongoose.connect(configuredUri, {
      maxPoolSize: 25,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000
    });
    console.log(`✅ Connected cleanly to MongoDB (${sanitizedUri})`);
    await ensureSchema();
    return mongoose.connection;
  }

  if (allowInMemory) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    inMemoryServer = await MongoMemoryServer.create();
    const memoryUri = inMemoryServer.getUri();
    await mongoose.connect(memoryUri);
    console.warn(`⚠️ [DEV/TEST ONLY] Connected to ephemeral MongoMemoryServer (${memoryUri})`);
    await ensureSchema();
    return mongoose.connection;
  }

  throw new Error('FATAL: MONGO_URI / MONGODB_URI is not configured in production environment. Refusing to boot with an ephemeral database.');
};

const stopDB = async () => {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (inMemoryServer) {
      await inMemoryServer.stop();
      inMemoryServer = null;
    }
  } catch (err) {
    console.error('Error stopping DB:', err.message);
  }
};

module.exports = {
  connectDB,
  stopDB,
  ensureSchema
};
