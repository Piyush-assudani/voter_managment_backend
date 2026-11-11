const fs = require('fs');
const { executeWithResilience } = require('./outboundService');
let cloudinary = null;

try {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();

  if (cloudName && apiKey && apiSecret) {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret
    });
  } else {
    console.warn('[cloudinaryService] CLOUDINARY_* env vars not set; cloud photo upload/delete disabled cleanly.');
  }
} catch (err) {
  console.warn('[cloudinaryService] Cloudinary module not loaded:', err.message);
}

/**
 * Upload a single voter photo to Cloudinary
 * @param {string} filePath - Absolute path to photo on disk
 * @param {string} publicId - Cloudinary public_id
 * @param {string} folder - Destination folder
 * @returns {Promise<string|null>} - secure_url or null
 */
async function uploadSinglePhoto(filePath, publicId, folder = 'voters') {
  if (!cloudinary) return null;
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const res = await executeWithResilience(
      'cloudinary',
      () => cloudinary.uploader.upload(filePath, {
        folder,
        public_id: publicId,
        overwrite: true,
        resource_type: 'image',
        format: 'webp'
      }),
      { maxRetries: 2, baseDelayMs: 300 }
    );
    return res.secure_url || null;
  } catch (err) {
    console.warn(`[cloudinaryService] Upload failed for ${publicId}:`, err.message);
    return null;
  }
}

/**
 * Batch upload voter photos with concurrency control
 */
async function uploadVoterPhotosBatch(items, concurrency = 15, onProgress = null) {
  const results = new Map();
  if (!cloudinary || !items || items.length === 0) return results;

  let completed = 0;
  const total = items.length;

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkPromises = chunk.map(async (item) => {
      const url = await uploadSinglePhoto(item.filePath, item.publicId);
      if (url) {
        results.set(item.publicId, url);
      }
      completed++;
      if (onProgress && (completed % 10 === 0 || completed === total)) {
        onProgress(completed, total);
      }
    });

    await Promise.all(chunkPromises);
  }

  return results;
}

function getPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?([^.]+)/);
  return match ? match[1] : null;
}

async function deleteSinglePhoto(photoUrlOrPublicId) {
  if (!cloudinary || !photoUrlOrPublicId) return false;
  try {
    const publicId = photoUrlOrPublicId.includes('cloudinary')
      ? getPublicIdFromUrl(photoUrlOrPublicId)
      : photoUrlOrPublicId;
    if (!publicId) return false;
    await cloudinary.uploader.destroy(publicId);
    return true;
  } catch (err) {
    console.warn(`[cloudinaryService] deleteSinglePhoto failed for ${photoUrlOrPublicId}:`, err.message);
    return false;
  }
}

async function deleteVoterPhotos(photoUrlsOrPublicIds) {
  if (!cloudinary || !Array.isArray(photoUrlsOrPublicIds) || photoUrlsOrPublicIds.length === 0) return 0;
  const publicIds = photoUrlsOrPublicIds
    .map((u) => (u && u.includes('cloudinary') ? getPublicIdFromUrl(u) : u))
    .filter(Boolean);

  if (publicIds.length === 0) return 0;

  let deletedCount = 0;
  for (let i = 0; i < publicIds.length; i += 100) {
    const chunk = publicIds.slice(i, i + 100);
    try {
      const res = await cloudinary.api.delete_resources(chunk);
      if (res && res.deleted) {
        deletedCount += Object.keys(res.deleted).length;
      }
    } catch (err) {
      console.warn('[cloudinaryService] deleteVoterPhotos error chunk:', err.message);
    }
  }
  return deletedCount;
}

async function deleteOrganizationPhotos(organizationId) {
  if (!cloudinary || !organizationId) return false;
  try {
    const prefix = `voters/${organizationId}_`;
    await cloudinary.api.delete_resources_by_prefix(prefix);
    return true;
  } catch (err) {
    console.warn(`[cloudinaryService] deleteOrganizationPhotos error for ${organizationId}:`, err.message);
    return false;
  }
}

module.exports = {
  cloudinary,
  uploadSinglePhoto,
  uploadVoterPhotosBatch,
  deleteSinglePhoto,
  deleteVoterPhotos,
  deleteOrganizationPhotos,
  getPublicIdFromUrl
};
