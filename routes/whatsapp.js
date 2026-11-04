const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { verifyToken, requireModule, isAdmin } = require('../middleware/authMiddleware');
const { addVoterAccess, getEffectiveOrgId } = require('../lib/access');
const { Voter, SlipDispatch, Organization, CampaignTemplate } = require('../models/index');
const { escapeRegex } = require('../lib/regexUtils');
const { normalizeDevanagariDigits } = require('../lib/phoneUtils');

/**
 * Resolve effective Meta configuration (Token, Phone ID, WABA ID)
 * Priorities: Organization level -> org_default -> process.env
 */
async function getEffectiveMetaConfig(orgId) {
  let org = null;
  let defaultOrg = null;
  try {
    if (orgId) {
      org = await Organization.findById(orgId).lean();
    }
    if (orgId !== 'org_default') {
      defaultOrg = await Organization.findById('org_default').lean();
    }
  } catch (e) {
    // ignore
  }

  const token = (org?.whatsappConfig?.token || defaultOrg?.whatsappConfig?.token || process.env.META_WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (org?.whatsappConfig?.phoneNumberId || defaultOrg?.whatsappConfig?.phoneNumberId || process.env.META_PHONE_ID || '').trim();
  const wabaId = (org?.whatsappConfig?.wabaId || defaultOrg?.whatsappConfig?.wabaId || process.env.META_WABA_ID || '').trim();
  const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';
  const templateName = org?.whatsappConfig?.templateName || org?.slipConfig?.whatsappTemplateName || defaultOrg?.whatsappConfig?.templateName || defaultOrg?.slipConfig?.whatsappTemplateName || 'voter_campaign_appeal';
  const templateLanguage = org?.whatsappConfig?.templateLanguage || defaultOrg?.whatsappConfig?.templateLanguage || 'hi';

  return { token, phoneNumberId, wabaId, graphApiVersion, templateName, templateLanguage };
}

/**
 * Resolve public base URL for voter slip images
 */
function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.trim().replace(/\/+$/, '');
  }
  const forwardedProto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : req.protocol || 'https');
  const forwardedHost = req.headers['x-forwarded-host'] || req.get('host') || '';
  if (
    !forwardedHost ||
    forwardedHost.includes('localhost') ||
    forwardedHost.includes('127.0.0.1') ||
    forwardedHost.startsWith('192.168.') ||
    forwardedHost.startsWith('10.')
  ) {
    return `http://${forwardedHost || 'localhost:5003'}`;
  }
  return `${forwardedProto}://${forwardedHost}`;
}

/**
 * Save rendered voter slip base64 image to disk
 */
function saveSlipImage(dispatchId, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }
  try {
    const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!matches) return null;
    const rawExt = matches[1].toLowerCase();
    const ext = rawExt.includes('jpeg') ? 'jpg' : rawExt.includes('png') ? 'png' : 'webp';
    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `slip_${dispatchId}.${ext}`;
    const targetDir = path.join(__dirname, '../uploads/slips');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, buffer);
    return {
      filename,
      buffer,
      ext,
      mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      size: buffer.length
    };
  } catch (err) {
    console.warn('Failed to save slip image:', err.message);
    return null;
  }
}

/**
 * Upload image buffer to Meta WhatsApp Media API
 */
async function uploadMediaToMeta({ token, phoneNumberId, buffer, mimeType, filename }) {
  if (!token || !phoneNumberId || !buffer) return null;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buffer], { type: mimeType || 'image/png' }), filename || 'voter_slip.png');
    form.append('type', mimeType || 'image/png');

    const res = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 20000,
      }
    );
    return res.data?.id || null;
  } catch (err) {
    console.warn('Meta media upload failed:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Standardize recipient phone number for WhatsApp Meta API (E.164 without '+')
 * Auto-handles Indian 10-digit numbers by prefixing 91
 */
function normalizePhoneNumber(input) {
  if (!input) return "";
  const devanagariCleaned = normalizeDevanagariDigits(input);
  let digits = devanagariCleaned.replace(/[^\d]/g, '');
  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  // Standard 10-digit Indian mobile number
  if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}

let cachedMetaHealth = { timestamp: 0, canSendMessage: true, reason: '', errors: [] };

/**
 * Live Health Check for Meta WhatsApp Cloud API (Payment Method & Account Blockage)
 */
async function checkMetaHealth(phoneNumberId, token, graphApiVersion = 'v20.0') {
  if (!phoneNumberId || !token) {
    return { canSendMessage: false, reason: 'Meta API कॉन्फ़िगर नहीं है।' };
  }
  const now = Date.now();
  if (now - cachedMetaHealth.timestamp < 60000) { // cache for 1 minute
    return cachedMetaHealth;
  }
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}?fields=health_status,name_status,status`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 6000 }
    );
    const health = res.data?.health_status;
    const nameStatus = res.data?.name_status;
    
    if (health?.can_send_message === 'BLOCKED') {
      const wabaEntity = health.entities?.find(e => e.entity_type === 'WABA');
      const wabaError = wabaEntity?.errors?.[0];
      const errorCode = wabaError?.error_code || 141006;
      let desc = wabaError?.error_description || 'Meta WhatsApp Business खाते द्वारा संदेश भेजना ब्लॉक (BLOCKED) है।';
      let solution = wabaError?.possible_solution || 'कृपया Meta Business Manager में पेमेंट मेथड जोड़ें।';
      
      if (errorCode === 141006) {
        desc = 'Meta Business Manager में WhatsApp Business Account (MOXRATHORE.com) पर पेमेंट मेथड (कार्ड) की त्रुटि है, जिससे Meta ने बिजनेस संदेश भेजना रोक रखा है।';
        solution = 'Meta Business Suite में जाकर नया Payment Method (कार्ड) जोड़ें।';
      }

      cachedMetaHealth = {
        timestamp: now,
        canSendMessage: false,
        reason: `${desc} ${solution}`,
        errorCode,
        nameStatus
      };
      return cachedMetaHealth;
    }

    cachedMetaHealth = { timestamp: now, canSendMessage: true, reason: '', nameStatus };
    return cachedMetaHealth;
  } catch (err) {
    // If health API fails (e.g. timeout), do not hard-block
    return { timestamp: now, canSendMessage: true, reason: '' };
  }
}

/**
 * Deduplication tracker: tracks phone numbers dispatched in current campaign round
 * Prevents spamming 10 identical messages if multiple family members share the same phone number.
 */
const recentPhoneDispatches = new Map();

function checkAndRecordPhoneDispatch(orgId, phone) {
  const key = `${orgId}_${phone}`;
  const now = Date.now();
  const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes round cooldown

  if (recentPhoneDispatches.size > 20000) {
    for (const [k, time] of recentPhoneDispatches.entries()) {
      if (now - time > DEDUP_WINDOW_MS) recentPhoneDispatches.delete(k);
    }
  }

  const lastSent = recentPhoneDispatches.get(key);
  if (lastSent && (now - lastSent) < DEDUP_WINDOW_MS) {
    return { alreadySent: true, lastSentAgoSec: Math.round((now - lastSent) / 1000) };
  }
  recentPhoneDispatches.set(key, now);
  return { alreadySent: false };
}

/**
 * Helper to check and deduct 1 credit atomically from organization
 */
async function verifyAndDeductCredit(orgId) {
  let org = await Organization.findById(orgId);
  if (!org && orgId === 'org_default') {
    org = await Organization.create({
      _id: 'org_default',
      name: 'Default Organization',
      whatsappEnabled: true,
      whatsappCredits: 500,
      whatsappUsed: 0
    });
  }
  if (!org) {
    return { ok: false, error: 'संगठन रिकॉर्ड नहीं मिला।' };
  }
  if (org.whatsappEnabled === false) {
    return {
      ok: false,
      error: 'एडमिन द्वारा आपके संगठन के लिए WhatsApp मैसेजिंग बंद (Disabled) की गई है।'
    };
  }
  const credits = typeof org.whatsappCredits === 'number' ? org.whatsappCredits : 0;
  if (credits <= 0) {
    return {
      ok: false,
      error: 'आपके संगठन के WhatsApp क्रेडिट समाप्त हो चुके हैं (0 क्रेडिट शेष)। कृपया एडमिन से और क्रेडिट प्राप्त करें।'
    };
  }

  const updated = await Organization.findOneAndUpdate(
    { _id: org._id, whatsappCredits: { $gt: 0 } },
    { $inc: { whatsappCredits: -1, whatsappUsed: 1 } },
    { new: true }
  );

  if (!updated) {
    return {
      ok: false,
      error: 'WhatsApp क्रेडिट समाप्त हो चुके हैं। कृपया एडमिन से क्रेडिट बढ़वाएं।'
    };
  }

  return { ok: true, remainingCredits: updated.whatsappCredits };
}

async function refundCredit(orgId) {
  try {
    await Organization.updateOne(
      { _id: orgId },
      { $inc: { whatsappCredits: 1, whatsappUsed: -1 } }
    );
  } catch (err) {
    console.error('Error refunding credit:', err.message);
  }
}

/**
 * GET /api/whatsapp/quota - Check current organization's WhatsApp credits and status
 */
router.get('/quota', verifyToken, async (req, res) => {
  try {
    const orgId = req.user.organizationId || 'org_default';
    let org = await Organization.findById(orgId).lean();
    if (!org && orgId === 'org_default') {
      org = { whatsappEnabled: true, whatsappCredits: 500, whatsappUsed: 0 };
    }
    const token = process.env.META_WHATSAPP_TOKEN?.trim();
    const phoneNumberId = process.env.META_PHONE_ID?.trim();
    const metaConfigured = Boolean(token && phoneNumberId);

    const credits = typeof org?.whatsappCredits === 'number' ? org.whatsappCredits : 100;
    const enabled = org ? org.whatsappEnabled !== false : true;
    const used = typeof org?.whatsappUsed === 'number' ? org.whatsappUsed : 0;

    res.json({
      organizationId: orgId,
      organizationName: org?.name || 'Default Organization',
      whatsappEnabled: enabled,
      whatsappCredits: credits,
      whatsappUsed: used,
      canSend: enabled && credits > 0,
      metaConfigured
    });
  } catch (err) {
    console.error('Error fetching WhatsApp quota:', err.message);
    res.status(500).json({ message: 'Quota could not be retrieved.' });
  }
});

/**
 * GET /api/whatsapp/status - Check Meta API configuration status
 */
router.get('/status', (req, res) => {
  const token = process.env.META_WHATSAPP_TOKEN?.trim();
  const phoneNumberId = process.env.META_PHONE_ID?.trim();
  const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';
  const hasWebhookSecret = Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN);

  const isConfigured = Boolean(token && phoneNumberId);

  res.json({
    configured: isConfigured,
    graphApiVersion,
    phoneNumberId: phoneNumberId ? `...${phoneNumberId.slice(-4)}` : null,
    hasToken: Boolean(token),
    hasWebhookSecret,
    metaDocumentation: "https://developers.facebook.com/docs/whatsapp/cloud-api"
  });
});

/**
 * GET /api/whatsapp/health - Check live Meta WhatsApp sending health & billing status
 */
router.get('/health', async (req, res) => {
  const token = process.env.META_WHATSAPP_TOKEN?.trim();
  const phoneNumberId = process.env.META_PHONE_ID?.trim();
  const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';
  const health = await checkMetaHealth(phoneNumberId, token, graphApiVersion);
  res.json({
    success: true,
    ...health
  });
});

/**
 * GET /api/whatsapp/webhook - Meta Webhook Verification
 * Used by Meta Developers Console to verify the webhook URL
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'matdata_webhook_verify_token';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('✅ Meta WhatsApp Webhook verified successfully!');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Meta WhatsApp Webhook verification mismatch:', { mode, token });
  return res.status(403).json({ error: 'Webhook verification token mismatch' });
});

/**
 * POST /api/whatsapp/webhook - Meta Status Updates & Incoming Messages
 * Receives real-time delivery receipts (sent, delivered, read, failed)
 */
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;

          // Process status updates (sent, delivered, read, failed)
          if (value && value.statuses) {
            for (const statusObj of value.statuses) {
              const messageId = statusObj.id; // wamid.HBg...
              const status = statusObj.status; // sent | delivered | read | failed
              const timestamp = statusObj.timestamp ? new Date(parseInt(statusObj.timestamp) * 1000) : new Date();

              const updateData = { status };
              if (status === 'delivered') updateData.deliveredAt = timestamp;
              if (status === 'read') updateData.readAt = timestamp;

              if (status === 'failed' && statusObj.errors) {
                const err = statusObj.errors[0] || {};
                const errCode = err.code;
                const errTitle = err.title || err.message || '';
                let errorMsg = `Meta डिलीवरी विफल (#${errCode || 'err'}): ${errTitle || 'त्रुटि'}`;
                if (errCode === 131049 || errCode === 131056) {
                  errorMsg = 'Meta मार्केटिंग सीमा (#131049): समान नंबर पर हाल ही में संदेश भेजा गया था, Meta ने डिलीवरी होल्ड/रोक दी।';
                } else if (errCode === 131026) {
                  errorMsg = 'Meta (#131026): मोबाइल नंबर WhatsApp पर मौजूद नहीं है या अमान्य है।';
                } else if (errCode === 131047) {
                  errorMsg = 'Meta 24-घंटे नीति (#131047): 24 घंटे का सत्र समाप्त।';
                }
                updateData.errorMessage = errorMsg;
              }

              try {
                await SlipDispatch.updateOne(
                  { providerMessageId: messageId },
                  {
                    $set: {
                      ...updateData,
                      'conversationHistory.$[elem].status': status
                    }
                  },
                  {
                    arrayFilters: [{ 'elem.messageId': messageId }]
                  }
                );
              } catch (updateErr) {
                await SlipDispatch.updateOne(
                  { providerMessageId: messageId },
                  { $set: updateData }
                ).catch(() => {});
              }
              
              console.log(`WhatsApp Status for [${messageId}]: ${status}`);
            }
          }

          // Process incoming customer messages (opens 24-hr customer service window)
          if (value && value.messages) {
            for (const msg of value.messages) {
              const fromPhone = String(msg.from || '').replace(/\D/g, '');
              const text = msg.text?.body || (msg.type ? `[${msg.type}]` : 'संदेश प्राप्त हुआ');
              const now = new Date();
              const windowExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);

              const last10 = fromPhone.slice(-10);
              await SlipDispatch.updateMany(
                { recipientPhone: new RegExp(last10) },
                {
                  $set: { windowExpiresAt: windowExpiry },
                  $push: {
                    conversationHistory: {
                      direction: 'inbound',
                      text,
                      status: 'read',
                      timestamp: now,
                      messageId: msg.id || null
                    }
                  }
                }
              ).catch(() => {});
              console.log(`WhatsApp Inbound 24h Window Opened for [${fromPhone}]: ${text}`);
            }
          }
        }
      }
    }

    // Acknowledge receipt to Meta within 3 seconds
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(200).send('EVENT_RECEIVED');
  }
});

/**
 * POST /api/whatsapp/send-slip - Send digital voter slip via Meta Cloud API (Supports photo & template)
 */
router.post('/send-slip', verifyToken, requireModule('voters'), async (req, res) => {
  let dispatchId = null;
  let metaAccepted = false;
  const orgId = req.user.organizationId || 'org_default';

  try {
    let { voterId, phoneNumber, templateName, slipImageDataUrl } = req.body;
    const metaConfig = await getEffectiveMetaConfig(orgId);
    const token = metaConfig.token;
    const phoneNumberId = metaConfig.phoneNumberId;
    const graphApiVersion = metaConfig.graphApiVersion || 'v20.0';

    // Use template selected by Admin or passed from client, falling back to effective org template
    if (!templateName) {
      templateName = metaConfig.templateName || 'voter_campaign_appeal';
    }

    if (!token || !phoneNumberId) {
      return res.status(503).json({
        message: 'Meta Cloud API कॉन्फ़िगर नहीं है। कृपया सुपर एडमिन में Meta टोकन व Phone ID दर्ज करें या "डायरेक्ट WhatsApp" का उपयोग करें।'
      });
    }

    // Proactive Meta Cloud API Account Health & Billing Check
    const health = await checkMetaHealth(phoneNumberId, token, graphApiVersion);
    if (!health.canSendMessage) {
      return res.status(422).json({
        success: false,
        isBlocked: true,
        message: `⚠️ Meta WhatsApp रोक: ${health.reason} कृपया 'डायरेक्ट WhatsApp (फोटो + पर्ची)' बटन का उपयोग करें, जिससे 100% तुरंत संदेश चला जाएगा।`
      });
    }

    if (!voterId || typeof phoneNumber !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
      return res.status(400).json({ message: 'वैध मतदाता ID और मोबाइल नंबर आवश्यक है।' });
    }

    // Verify credits and deduct 1 credit
    const creditCheck = await verifyAndDeductCredit(orgId);
    if (!creditCheck.ok) {
      return res.status(403).json({ message: creditCheck.error });
    }

    const recipientPhone = normalizePhoneNumber(phoneNumber);
    if (recipientPhone.length < 10) {
      await refundCredit(orgId);
      return res.status(400).json({ message: 'कृपया 10 अंकों का वैध मोबाइल नंबर दर्ज करें।' });
    }

    // Deduplication check: In a single round / 10m window, do not send 10 times to the same phone number
    const forceSend = req.body.forceSend === true || req.body.force === true;
    if (!forceSend) {
      const dedup = checkAndRecordPhoneDispatch(orgId, recipientPhone);
      if (dedup.alreadySent) {
        await refundCredit(orgId);
        return res.json({
          success: true,
          deduplicated: true,
          message: `ℹ️ इस मोबाइल नंबर (${recipientPhone}) पर इसी राउंड में पहले ही संदेश भेजा जा चुका है (${dedup.lastSentAgoSec}s पूर्व)। डुप्लीकेट संदेश रोका गया व क्रेडिट सुरक्षित रहा।`,
          recipientPhone
        });
      }
    }

    const query = addVoterAccess(req);
    if (!isNaN(voterId)) {
      query.sqlId = Number.parseInt(voterId, 10);
    } else {
      query._id = voterId;
    }

    const dbVoter = await Voter.findOne(query).lean();
    if (!dbVoter) {
      await refundCredit(orgId);
      return res.status(404).json({ message: 'मतदाता रिकॉर्ड नहीं मिला।' });
    }

    // Persist phone number to Voter record in DB so it is permanently remembered
    const cleanPhoneDigits = recipientPhone.slice(-10);
    if (cleanPhoneDigits && cleanPhoneDigits.length === 10) {
      await Voter.updateOne(
        { _id: dbVoter._id },
        { $set: { phone: cleanPhoneDigits, mobileNo: cleanPhoneDigits } }
      ).catch(() => {});
    }

    const org = await Organization.findById(orgId).lean();
    const candidateName = (
      req.body.candidateName ||
      org?.slipConfig?.candidateName ||
      org?.name ||
      'माननीय प्रत्याशी'
    ).toString().trim();
    const voterName = dbVoter.nameHi || dbVoter.nameEn || 'मतदाता';
    const ward = (dbVoter.wardNo || '').toString().trim().replace(/^(वार्ड|Ward)\s*/i, '') || '—';
    const cleanWard = (dbVoter.wardNo || '').toString().trim().replace(/^(वार्ड|Ward)\s*/i, '').trim();
    const rawWard = (dbVoter.wardNo || '').toString().trim();
    const part = (dbVoter.partNo || req.body.partNo || '').toString().trim().replace(/^(भाग|Part)\s*/i, '').trim() || '—';
    const serial = dbVoter.serialNo || '—';
    const displayEpic = (dbVoter.epic && !dbVoter.epic.startsWith('VOTER_') && !dbVoter.epic.startsWith('UNREADABLE_')) ? dbVoter.epic : '—';
    const wardStation = org?.slipConfig?.wardPollingStations && typeof org.slipConfig.wardPollingStations === 'object'
      ? (org.slipConfig.wardPollingStations[cleanWard]
         || org.slipConfig.wardPollingStations[rawWard]
         || org.slipConfig.wardPollingStations[`वार्ड ${cleanWard}`]
         || org.slipConfig.wardPollingStations[`Ward ${cleanWard}`]
         || Object.entries(org.slipConfig.wardPollingStations).find(([k, v]) => k.replace(/^(वार्ड|Ward)\s*/i, '').trim() === cleanWard && typeof v === 'string' && v.trim())?.[1])
      : null;
    const boothName = (wardStation && wardStation.trim()) || dbVoter.boothName || org?.slipConfig?.pollingStationFallback || `भाग संख्या ${part}`;

    // Create Dispatch record in DB (strictly bound to user's organization)
    const dispatch = await SlipDispatch.create({
      _id: `disp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      voterId: dbVoter._id,
      voterEpic: displayEpic,
      voterName,
      recipientPhone,
      status: 'sending',
      organizationId: orgId,
      sentBy: req.user.fullName || req.user.email || 'Client'
    });
    dispatchId = dispatch._id;

    // Handle slip image saving
    let savedImage = null;
    let mediaId = null;
    let publicImageUrl = null;
    if (slipImageDataUrl) {
      savedImage = saveSlipImage(dispatchId, slipImageDataUrl);
      if (savedImage) {
        publicImageUrl = `${getPublicBaseUrl(req)}/uploads/slips/${savedImage.filename}`;
        mediaId = await uploadMediaToMeta({
          token,
          phoneNumberId,
          buffer: savedImage.buffer,
          mimeType: savedImage.mimeType,
          filename: savedImage.filename
        });
      }
    }

    const messageText = `🗳️ *आधिकारिक मतदाता सूचना पर्ची* 🗳️

नमस्कार *${voterName}* जी,
आपकी डिजिटल मतदाता सूचना पर्ची विवरण:

• पहचान पत्र (EPIC): *${displayEpic}*
• नाम: *${voterName}*
• प्रत्याशी: *${candidateName}*
• वार्ड: *${ward}* · भाग संख्या: *${part}*
• मतदाता सूची क्रमांक: *${serial}*
• मतदान केंद्र: *${boothName}*

${publicImageUrl ? `🖼️ डिजिटल पर्ची फोटो: ${publicImageUrl}\n\n` : ''}🇮🇳 मतदान हमारा अधिकार एवं कर्तव्य है। कृपया पहचान पत्र (Voter ID/आधार कार्ड) साथ लाएं।
*— कार्यालय ${candidateName}*`;

    let response;
    let lastError = null;

    // Helper to build 7 parameters for Meta voter slip templates
    const buildTemplateParams = (tmplName) => {
      return [
        { type: 'text', text: voterName || 'मतदाता' },
        { type: 'text', text: candidateName || 'माननीय प्रत्याशी' },
        { type: 'text', text: displayEpic || '—' },
        { type: 'text', text: String(ward || '—') },
        { type: 'text', text: String(part || '—') },
        { type: 'text', text: String(serial || '—') },
        { type: 'text', text: String(boothName || '—') }
      ];
    };

    // Candidate template names to try in order of priority (Active Approved Marketing Template)
    const templatesToTry = [
      templateName,
      'voter_campaign_appeal'
    ].filter((t, idx, arr) => Boolean(t) && arr.indexOf(t) === idx);

    // 1. Try sending via Meta Approved Template
    for (const curTemplate of templatesToTry) {
      if (response) break;
      try {
        const components = [];
        // Header Image (IMAGE header is mandatory for voter_campaign_appeal)
        const effectiveImageUrl = publicImageUrl || org?.slipConfig?.headerGraphicImage || 'https://images.unsplash.com/photo-1540910419892-4a36d2c3266c?auto=format&fit=crop&w=800&q=80';
        if (mediaId || effectiveImageUrl) {
          components.push({
            type: 'header',
            parameters: [
              mediaId
                ? { type: 'image', image: { id: mediaId } }
                : { type: 'image', image: { link: effectiveImageUrl } }
            ]
          });
        }
        // Body parameters
        components.push({
          type: 'body',
          parameters: buildTemplateParams(curTemplate)
        });

        const templatePayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipientPhone,
          type: 'template',
          template: {
            name: curTemplate,
            language: { code: 'hi' },
            components
          }
        };

        const res = await axios.post(
          `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
          templatePayload,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        if (res.data?.messages?.[0]?.id) {
          response = res;
          console.log(`✅ Meta WhatsApp template [${curTemplate}] delivered successfully to ${recipientPhone}`);
          break;
        }
      } catch (tmplErr) {
        lastError = tmplErr;
        const errDetail = tmplErr.response?.data?.error?.message || '';
        console.warn(`Template [${curTemplate}] attempt failed:`, errDetail || tmplErr.message);

        // If template rejected header parameter (e.g. template does not have image header), retry without header parameter
        if (errDetail.includes('header') || errDetail.includes('parameters')) {
          try {
            const noHeaderPayload = {
              ...templatePayload,
              template: {
                ...templatePayload.template,
                components: components.filter((c) => c.type === 'body')
              }
            };
            const retryRes = await axios.post(
              `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
              noHeaderPayload,
              { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            if (retryRes.data?.messages?.[0]?.id) {
              response = retryRes;
              console.log(`✅ Meta WhatsApp template [${curTemplate}] delivered without header to ${recipientPhone}`);
              break;
            }
          } catch (retryErr) {
            lastError = retryErr;
          }
        }
      }
    }

    // 2. If templates didn't go through, check if 24-hr customer service window is open
    if (!response) {
      let isWindowOpen = false;
      try {
        const last10 = recipientPhone.slice(-10);
        const inbound = await SlipDispatch.findOne({
          recipientPhone: new RegExp(last10),
          windowExpiresAt: { $gt: new Date() }
        }).lean();
        if (inbound) {
          isWindowOpen = true;
        }
      } catch (e) {
        // ignore
      }

      if (isWindowOpen) {
        // Customer initiated contact in last 24h: freeform media/text is permitted
        if (mediaId || publicImageUrl) {
          const imageParam = mediaId ? { id: mediaId } : { link: publicImageUrl };
          try {
            response = await axios.post(
              `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
              {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipientPhone,
                type: 'image',
                image: { ...imageParam, caption: messageText }
              },
              { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 12000 }
            );
          } catch (imgErr) {
            console.warn('Direct image in 24h window failed, trying text:', imgErr.response?.data || imgErr.message);
          }
        }

        if (!response) {
          const fullText = publicImageUrl ? `${messageText}\n\n🖼️ *डिजिटल पर्ची फोटो:*\n${publicImageUrl}` : messageText;
          response = await axios.post(
            `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
            {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: recipientPhone,
              type: 'text',
              text: { preview_url: true, body: fullText }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 12000 }
          );
        }
      } else {
        // 24-hr window is CLOSED and all Meta templates failed!
        // DO NOT silently send plain text (which Meta accepts in HTTP 200 queue but drops permanently).
        const metaErrMsg = lastError?.response?.data?.error?.message || lastError?.message || 'Meta टेम्पलेट उपलब्ध नहीं या अस्वीकृत है।';
        const err = new Error(`Meta 24-घंटे नीति: नए मतदाता को संदेश केवल Meta Approved Template द्वारा ही भेजा जा सकता है। (${metaErrMsg})`);
        err.isTemplatePending = true;
        throw err;
      }
    }

    metaAccepted = true;
    const providerMessageId = response.data?.messages?.[0]?.id;

    await SlipDispatch.updateOne(
      { _id: dispatchId },
      { $set: { status: 'sent', providerMessageId, slipImageUrl: publicImageUrl } }
    );

    res.json({
      success: true,
      message: 'Meta API ने पर्ची स्वीकार कर ली है (वितरण कतार में)। स्थिति History पेज पर देखें।',
      dispatchId,
      providerMessageId,
      slipImageUrl: publicImageUrl,
      hasPhoto: Boolean(savedImage)
    });

  } catch (err) {
    let errorDetail = err.response?.data?.error?.message || err.message;
    const errorCode = err.response?.data?.error?.code;

    // Helpful error messages for common Meta codes
    if (err.isTemplatePending) {
      errorDetail = err.message;
    } else if (errorCode === 131030) {
      errorDetail = `Meta टेस्ट मोड प्रतिबंध (#131030): नंबर (+91 ${recipientPhone?.slice(-10)}) Meta Developer Console की Allowed Numbers लिस्ट में नहीं है। कृपया Meta Developers Console में जाकर यह नंबर जोड़ें या फिर "डायरेक्ट WhatsApp भेजें" (1-Click) का उपयोग करें।`;
    } else if (errorCode === 131049 || errorCode === 131056) {
      errorDetail = 'Meta मार्केटिंग सीमा (#131049): इस नंबर पर हाल ही में संदेश भेजा जा चुका है। Meta मार्केटिंग नियमों के तहत एक ही नंबर पर बार-बार संदेश भेजने पर रोक (होल्ड) लग जाती है।';
    } else if (errorCode === 131047) {
      errorDetail = 'Meta 24-घंटे नीति (#131047): मतदाता ने पिछले 24 घंटे में आपके नंबर पर मैसेज नहीं किया है। इस नंबर पर सीधा संदेश भेजने के लिए Meta Approved Template आवश्यक है। कृपया "डायरेक्ट WhatsApp" बटन का उपयोग करें।';
    } else if (errorCode === 131026) {
      errorDetail = 'मोबाइल नंबर Meta WhatsApp पर मौजूद नहीं है या अमान्य है।';
    } else if (errorCode === 190) {
      errorDetail = 'Meta Access Token एक्सपायर हो गया है। कृपया नया Access Token दर्ज करें।';
    } else if (errorCode === 132001) {
      errorDetail = 'Meta Template नहीं मिला या समीक्षाधीन है (#132001)। कृपया Admin पैनल में स्वीकृत Meta Template चुनें या "डायरेक्ट WhatsApp" का प्रयोग करें।';
    }

    if (dispatchId) {
      await SlipDispatch.updateOne(
        { _id: dispatchId },
        { $set: { status: 'failed', errorMessage: errorDetail } }
      ).catch(() => {});
    }

    if (!metaAccepted) {
      await refundCredit(orgId);
    }

    console.error('WhatsApp send error:', err.response?.data || err.message);
    res.status(err.isTemplatePending ? 422 : (metaAccepted ? 207 : 500)).json({
      success: false,
      isTemplatePending: Boolean(err.isTemplatePending),
      message: errorDetail || 'Meta Graph API से WhatsApp संदेश भेजने में त्रुटि हुई।'
    });
  }
});

/**
 * POST /api/whatsapp/send-manual - Deduct 1 credit, record manual dispatch, save slip image, and generate direct WhatsApp link
 */
router.post('/send-manual', verifyToken, requireModule('voters'), async (req, res) => {
  const orgId = req.user.organizationId || 'org_default';
  try {
    const { voterId, phoneNumber, slipImageDataUrl } = req.body;
    if (!voterId || typeof phoneNumber !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
      return res.status(400).json({ message: 'वैध मतदाता ID और मोबाइल नंबर आवश्यक है।' });
    }

    const creditCheck = await verifyAndDeductCredit(orgId);
    if (!creditCheck.ok) {
      return res.status(403).json({ message: creditCheck.error });
    }

    const recipientPhone = normalizePhoneNumber(phoneNumber);
    if (recipientPhone.length < 10) {
      await refundCredit(orgId);
      return res.status(400).json({ message: 'कृपया 10 अंकों का वैध मोबाइल नंबर दर्ज करें।' });
    }

    // Deduplication check: In a single round / 10m window, do not send 10 times to the same phone number
    const forceSend = req.body.forceSend === true || req.body.force === true;
    if (!forceSend) {
      const dedup = checkAndRecordPhoneDispatch(orgId, recipientPhone);
      if (dedup.alreadySent) {
        await refundCredit(orgId);
        return res.json({
          success: true,
          deduplicated: true,
          message: `ℹ️ इस मोबाइल नंबर (${recipientPhone}) पर इसी राउंड में पहले ही संदेश भेजा जा चुका है (${dedup.lastSentAgoSec}s पूर्व)। डुप्लीकेट संदेश रोका गया व क्रेडिट सुरक्षित रहा।`,
          recipientPhone
        });
      }
    }

    const query = addVoterAccess(req);
    if (!isNaN(voterId)) {
      query.sqlId = Number.parseInt(voterId, 10);
    } else {
      query._id = voterId;
    }

    const dbVoter = await Voter.findOne(query).lean();
    if (!dbVoter) {
      await refundCredit(orgId);
      return res.status(404).json({ message: 'मतदाता रिकॉर्ड नहीं मिला।' });
    }

    // Persist phone number to Voter record in DB so it is permanently remembered
    const cleanPhoneDigits = recipientPhone.slice(-10);
    if (cleanPhoneDigits && cleanPhoneDigits.length === 10) {
      await Voter.updateOne(
        { _id: dbVoter._id },
        { $set: { phone: cleanPhoneDigits, mobileNo: cleanPhoneDigits } }
      ).catch(() => {});
    }

    const org = await Organization.findById(orgId).lean();
    const voterName = dbVoter.nameHi || dbVoter.nameEn || 'मतदाता';
    const ward = (dbVoter.wardNo || '').toString().trim().replace(/^(वार्ड|Ward)\s*/i, '') || '—';
    const cleanWard = (dbVoter.wardNo || '').toString().trim().replace(/^(वार्ड|Ward)\s*/i, '').trim();
    const rawWard = (dbVoter.wardNo || '').toString().trim();
    const part = (dbVoter.partNo || req.body.partNo || '').toString().trim() || '—';
    const serial = dbVoter.serialNo || '—';
    const displayEpic = (dbVoter.epic && !dbVoter.epic.startsWith('VOTER_') && !dbVoter.epic.startsWith('UNREADABLE_')) ? dbVoter.epic : '—';
    const wardStation = org?.slipConfig?.wardPollingStations && typeof org.slipConfig.wardPollingStations === 'object'
      ? (org.slipConfig.wardPollingStations[cleanWard]
         || org.slipConfig.wardPollingStations[rawWard]
         || org.slipConfig.wardPollingStations[`वार्ड ${cleanWard}`]
         || org.slipConfig.wardPollingStations[`Ward ${cleanWard}`]
         || Object.entries(org.slipConfig.wardPollingStations).find(([k, v]) => k.replace(/^(वार्ड|Ward)\s*/i, '').trim() === cleanWard && typeof v === 'string' && v.trim())?.[1])
      : null;
    const boothName = (wardStation && wardStation.trim()) || dbVoter.boothName || org?.slipConfig?.pollingStationFallback || `भाग संख्या ${part}`;
    const relativeName = dbVoter.relativeNameHi || dbVoter.relativeNameEn || '';
    const relationType = dbVoter.relationType || 'पिता/पति';
    const ageGender = `${dbVoter.age || '—'} वर्ष / ${dbVoter.gender || '—'}`;

    const isFamily = req.body.slipType === 'family';
    const familyCount = req.body.familyCount || 1;

    const dispatch = await SlipDispatch.create({
      _id: `disp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      voterId: dbVoter._id,
      voterEpic: displayEpic,
      voterName: isFamily ? `मकान #${dbVoter.houseNo || '—'} परिवार (${familyCount} सदस्य)` : voterName,
      recipientPhone,
      status: 'manual_link',
      dispatchType: 'manual_whatsapp',
      slipType: isFamily ? 'family' : 'individual',
      organizationId: orgId,
      sentBy: req.user.fullName || req.user.email || 'Client'
    });

    // Save image if passed
    let savedImage = null;
    let publicImageUrl = null;
    if (slipImageDataUrl) {
      savedImage = saveSlipImage(dispatch._id, slipImageDataUrl);
      if (savedImage) {
        publicImageUrl = `${getPublicBaseUrl(req)}/uploads/slips/${savedImage.filename}`;
        await SlipDispatch.updateOne({ _id: dispatch._id }, { $set: { slipImageUrl: publicImageUrl } });
      }
    }

    const viewUrl = `${getPublicBaseUrl(req)}/api/whatsapp/view/${dispatch._id}`;
    const directPhotoLink = publicImageUrl || viewUrl;

    let messageText = '';
    if (isFamily) {
      messageText = `🗳️ *आधिकारिक संयुक्त परिवार मतदाता सूचना पर्ची* 🗳️

नमस्कार,
आगामी चुनाव हेतु आपके परिवार (मकान #${dbVoter.houseNo || '—'}) की डिजिटल मतदाता पर्ची:

📸 *डिजिटल परिवार पर्ची फोटो यहाँ देखें:*
${directPhotoLink}

• *मकान संख्या:* #${dbVoter.houseNo || '—'}
• *वार्ड क्रमांक:* ${ward} · *भाग संख्या:* ${part}
• *मतदान केंद्र:* ${boothName}
• *परिवार में कुल मतदाता:* ${familyCount}

🇮🇳 _मतदान हमारा अधिकार एवं कर्तव्य है। मतदान हेतु पहचान पत्र अवश्य साथ लाएं।_
*— मतदाता पोर्टल (Matdata Portal) इलेक्शन मैनेजमेंट*`;
    } else {
      messageText = `🗳️ *आधिकारिक मतदाता सूचना पर्ची* 🗳️

नमस्कार *${voterName}* जी,
आगामी चुनाव हेतु आपकी मतदाता पर्ची का विवरण:

📸 *डिजिटल मतदाता पर्ची फोटो देखें / डाउनलोड करें:*
${directPhotoLink}

• *पहचान पत्र क्रमांक (EPIC):* ${displayEpic}
• *नाम:* ${voterName}
${relativeName ? `• *${relationType}:* ${relativeName}\n` : ''}• *वार्ड क्रमांक:* ${ward}
• *भाग संख्या:* ${part}
• *मतदाता सूची क्रमांक:* ${serial}
• *मतदान केंद्र:* ${boothName}
• *आयु / लिंग:* ${ageGender}

🇮🇳 _मतदान हमारा अधिकार एवं कर्तव्य है। कृपया पहचान पत्र (Voter ID/आधार कार्ड) साथ लाएं।_
*— मतदाता पोर्टल (Matdata Portal) इलेक्शन मैनेजमेंट*`;
    }

    const waLink = `https://wa.me/${recipientPhone}?text=${encodeURIComponent(messageText)}`;

    res.json({
      success: true,
      message: '1 WhatsApp क्रेडिट काटा गया।',
      dispatchId: dispatch._id,
      remainingCredits: creditCheck.remainingCredits,
      waLink,
      messageText,
      slipImageUrl: publicImageUrl,
      viewUrl,
      hasPhoto: Boolean(savedImage)
    });
  } catch (err) {
    console.error('Manual WhatsApp dispatch error:', err.message);
    res.status(500).json({ message: 'मैनुअल WhatsApp संदेश तैयार करने में त्रुटि हुई।' });
  }
});


// Public HTML page for viewing voter slip with OpenGraph meta tags for WhatsApp rich preview
router.get('/view/:id', async (req, res) => {
  try {
    const dispatch = await SlipDispatch.findById(req.params.id).lean();
    if (!dispatch) {
      return res.status(404).send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>पर्ची नहीं मिली</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;">
          <h2>मतदाता पर्ची नहीं मिली या लिंक समाप्त हो गया है।</h2>
        </body></html>
      `);
    }

    const baseUrl = getPublicBaseUrl(req);
    const imageUrl = dispatch.slipImageUrl || `${baseUrl}/uploads/slips/slip_${dispatch._id}.jpg`;
    const voterName = dispatch.voterName || 'मतदाता';
    const epic = dispatch.voterEpic || 'N/A';

    res.send(`<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>डिजिटल मतदाता पर्ची - ${voterName}</title>
  <meta property="og:title" content="🗳️ आधिकारिक डिजिटल मतदाता पर्ची - ${voterName}" />
  <meta property="og:description" content="पहचान पत्र (EPIC): ${epic} • आगामी चुनाव हेतु आपकी आधिकारिक डिजिटल मतदाता सूचना पर्ची" />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:secure_url" content="${imageUrl}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="600" />
  <meta property="og:image:height" content="800" />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="🗳️ डिजिटल मतदाता पर्ची - ${voterName}" />
  <meta name="twitter:image" content="${imageUrl}" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .slip-container {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 20px;
      max-width: 620px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .slip-img {
      width: 100%;
      max-width: 580px;
      height: auto;
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      display: block;
      margin: 16px auto;
    }
    .btn-group {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
      margin-top: 20px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 24px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 14px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .btn-download {
      background: #059669;
      color: #ffffff;
      border: none;
    }
    .btn-download:hover { background: #047857; }
    .btn-print {
      background: #334155;
      color: #ffffff;
      border: 1px solid #475569;
    }
    .btn-print:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="slip-container">
    <div style="font-size: 13px; font-weight: 800; color: #34d399; letter-spacing: 0.05em; text-transform: uppercase;">
      🇮🇳 चुनाव आयोग प्रारूप डिजिटल पर्ची
    </div>
    <h1 style="font-size: 20px; margin: 6px 0; color: #ffffff;">
      ${voterName} की मतदाता पर्ची
    </h1>
    <p style="margin: 0; font-size: 13px; color: #94a3b8;">
      EPIC: <strong style="color: #f1f5f9;">${epic}</strong>
    </p>

    <img src="${imageUrl}" alt="मतदाता पर्ची" class="slip-img" />

    <div class="btn-group">
      <a href="${imageUrl}" download="VoterSlip_${epic}.jpg" class="btn btn-download">
        📥 पर्ची डाउनलोड करें (Download Slip)
      </a>
      <button onclick="window.print()" class="btn btn-print">
        🖨️ प्रिंट करें (Print)
      </button>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Slip public view error:', err);
    res.status(500).send('Error loading slip');
  }
});

/**
 * GET /api/whatsapp/history - List recent voter slip dispatch records
 */
router.get('/history', verifyToken, requireModule('voters'), async (req, res) => {
  try {
    const query = {};
    const targetOrgId = getEffectiveOrgId(req);
    if (targetOrgId) {
      query.organizationId = targetOrgId;
    }

    const dispatches = await SlipDispatch.find(query).sort({ createdAt: -1 }).limit(100).lean();

    res.json(dispatches.map(d => ({
      id: d._id,
      voterId: d.voterId,
      epic: d.voterEpic,
      voterName: d.voterName,
      recipient: d.recipientPhone,
      status: d.status,
      timestamp: d.createdAt,
      deliveredAt: d.deliveredAt,
      readAt: d.readAt,
      errorMessage: d.errorMessage
    })));
  } catch (err) {
    console.error('Dispatch history failed:', err.message);
    res.status(500).json({ message: 'पर्ची इतिहास लोड नहीं हुआ।' });
  }
});

const DEFAULT_PRESET_TEMPLATES = [
  {
    name: 'voter_campaign_appeal',
    status: 'APPROVED',
    category: 'MARKETING',
    language: 'hi',
    hasImageHeader: true,
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      {
        type: 'BODY',
        text: 'आदरणीय {{1}} जी, सादर प्रणाम!\nआपके अपने जनसेवक व लोकप्रिय प्रत्याशी {{2}} की ओर से चुनाव में आपका बहुमूल्य आशीर्वाद और समर्थन सादर प्रार्थनीय है।\n\nआपकी मतदान पर्ची विवरण:\n• EPIC नंबर: {{3}}\n• वार्ड नंबर: {{4}}\n• भाग संख्या: {{5}}\n• क्रम संख्या: {{6}}\n• मतदान केंद्र: {{7}}\n\nक्षेत्र के चहुंमुखी विकास व प्रगति हेतु मतदान के दिन भारी संख्या में पहुँचकर विजय बनाएं। लोकतंत्र के महापर्व में अपना मत अवश्य दें!',
        example: {
          body_text: [['सुरेश वर्मा', 'राकेश चौधरी', 'RKS5544332', '8', '19', '77', 'राजकीय माध्यमिक विद्यालय कक्ष 1']]
        }
      }
    ]
  }
];

/**
 * GET /api/whatsapp/templates - Fetch Meta templates (live from Meta Graph API or presets)
 */
router.get('/templates', verifyToken, async (req, res) => {
  try {
    const orgId = req.query.organizationId || getEffectiveOrgId(req) || 'org_default';
    const org = await Organization.findById(orgId).lean();
    const defaultOrg = await Organization.findById('org_default').lean();
    const activeTemplate = org?.whatsappConfig?.templateName || org?.slipConfig?.whatsappTemplateName || defaultOrg?.whatsappConfig?.templateName || defaultOrg?.slipConfig?.whatsappTemplateName || 'voter_campaign_appeal';
    const activeLanguage = org?.whatsappConfig?.templateLanguage || defaultOrg?.whatsappConfig?.templateLanguage || 'hi';

    const token = process.env.META_WHATSAPP_TOKEN?.trim();
    const phoneNumberId = process.env.META_PHONE_ID?.trim();
    const configuredWabaId = process.env.META_WABA_ID?.trim() || '4105243026447031';
    const graphApiVersion = process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';

    let metaTemplates = [];
    let isLiveFromMeta = false;

    if (token) {
      try {
        let wabaId = configuredWabaId;
        if (!wabaId && phoneNumberId) {
          const phoneRes = await axios.get(
            `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}?fields=whatsapp_business_account`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
          );
          wabaId = phoneRes.data?.whatsapp_business_account?.id;
        }
        
        if (wabaId) {
          const tmplRes = await axios.get(
            `https://graph.facebook.com/${graphApiVersion}/${wabaId}/message_templates?limit=100`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 7000 }
          );
          if (Array.isArray(tmplRes.data?.data) && tmplRes.data.data.length > 0) {
            metaTemplates = tmplRes.data.data.map(t => ({
              ...t,
              hasImageHeader: Boolean(t.components?.some(c => (c.type === 'HEADER' || c.type === 'header') && (c.format === 'IMAGE' || c.format === 'image'))),
              headerFormat: t.components?.find(c => c.type === 'HEADER' || c.type === 'header')?.format || 'TEXT',
              buttons: t.components?.find(c => c.type === 'BUTTONS' || c.type === 'buttons')?.buttons || []
            }));
            isLiveFromMeta = true;
          }
        }
      } catch (metaErr) {
        console.warn('Could not fetch live templates from Meta Graph API:', metaErr.message);
      }
    }

    const combined = [...metaTemplates];
    for (const preset of DEFAULT_PRESET_TEMPLATES) {
      if (!combined.some(t => t.name.toLowerCase() === preset.name.toLowerCase())) {
        combined.push(preset);
      }
    }

    const activeDetails = combined.find(t => t.name.toLowerCase() === activeTemplate.toLowerCase()) || {
      name: activeTemplate,
      status: 'APPROVED',
      category: 'UTILITY',
      hasImageHeader: true
    };

    res.json({
      success: true,
      activeTemplate,
      activeLanguage,
      activeDetails,
      isLiveFromMeta,
      organizationId: orgId,
      organizationName: org?.name || 'Default Organization',
      templates: combined
    });
  } catch (err) {
    console.error('Error fetching templates:', err.message);
    res.status(500).json({ message: 'टेम्पलेट्स लोड नहीं हो पाए।' });
  }
});

/**
 * POST /api/whatsapp/templates/select-active - Select the active template for an organization or globally
 */
router.post('/templates/select-active', verifyToken, async (req, res) => {
  try {
    const { organizationId, templateName, templateLanguage } = req.body;
    if (!templateName) {
      return res.status(400).json({ message: 'टेम्पलेट का नाम आवश्यक है।' });
    }

    const cleanTemplate = templateName.trim();
    const cleanLang = templateLanguage || 'hi';

    if (organizationId) {
      await Organization.updateOne(
        { _id: organizationId },
        {
          $set: {
            'whatsappConfig.templateName': cleanTemplate,
            'whatsappConfig.templateLanguage': cleanLang,
            'slipConfig.whatsappTemplateName': cleanTemplate
          }
        },
        { upsert: true }
      );
    } else {
      // Global setting
      await Organization.updateOne(
        { _id: 'org_default' },
        {
          $set: {
            'whatsappConfig.templateName': cleanTemplate,
            'whatsappConfig.templateLanguage': cleanLang,
            'slipConfig.whatsappTemplateName': cleanTemplate
          }
        },
        { upsert: true }
      );
      // Also update all organizations so the default is propagated
      await Organization.updateMany(
        {},
        {
          $set: {
            'whatsappConfig.templateName': cleanTemplate,
            'whatsappConfig.templateLanguage': cleanLang,
            'slipConfig.whatsappTemplateName': cleanTemplate
          }
        }
      );
    }

    res.json({
      success: true,
      message: `Meta टेम्पलेट '${cleanTemplate}' सफलतापूर्वक सक्रिय (Active) कर दिया गया है। अब सभी संदेश इसी टेम्पलेट से डिलीवर होंगे।`,
      activeTemplate: cleanTemplate,
      activeLanguage: cleanLang
    });
  } catch (err) {
    console.error('Error selecting active template:', err.message);
    res.status(500).json({ message: 'टेम्पलेट सक्रिय नहीं किया जा सका।' });
  }
});

/**
 * Transliterate Devanagari/Hindi names to clean Meta-compliant template name (lowercase a-z, 0-9, _)
 */
const hindiConsonants = {
  'क':'ka','ख':'kha','ग':'ga','घ':'gha','ङ':'nga',
  'च':'cha','छ':'chha','ज':'ja','झ':'jha','ञ':'nya',
  'ट':'ta','ठ':'tha','ड':'da','ढ':'dha','ण':'na',
  'त':'ta','थ':'tha','द':'da','ध':'dha','न':'na',
  'प':'pa','फ':'pha','ब':'ba','भ':'bha','म':'ma',
  'य':'ya','र':'ra','ल':'la','व':'va','श':'sha','ष':'sha','स':'sa','ह':'ha',
  'क्ष':'ksha','त्र':'tra','ज्ञ':'gya','श्र':'shra'
};
const hindiMatras = {
  'ा':'a','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','ः':'h'
};
const hindiVowels = {
  'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','अं':'am','अः':'ah'
};
const hindiDigits = {
  '०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9'
};

function transliterateHindi(raw) {
  if (!raw) return '';
  let res = '';
  const str = String(raw).trim();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const nextCh = str[i + 1];
    if (hindiConsonants[ch]) {
      if (nextCh === '्') {
        res += hindiConsonants[ch].slice(0, -1);
        i++;
      } else if (hindiMatras[nextCh]) {
        res += hindiConsonants[ch].slice(0, -1) + hindiMatras[nextCh];
        i++;
      } else {
        res += hindiConsonants[ch];
      }
    } else if (hindiVowels[ch]) {
      res += hindiVowels[ch];
    } else if (hindiMatras[ch]) {
      res += hindiMatras[ch];
    } else if (hindiDigits[ch]) {
      res += hindiDigits[ch];
    } else {
      res += ch;
    }
  }
  return res;
}

function slugifyTemplateName(raw) {
  const roman = transliterateHindi(raw);
  let slug = roman.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug || slug.length < 2) {
    slug = 'voter_slip_' + Date.now();
  }
  return slug.slice(0, 50);
}

/**
 * POST /api/whatsapp/templates/create - Submit new template to Meta Cloud API (Supports Image Header, Text Header, Buttons)
 */
router.post('/templates/create', verifyToken, async (req, res) => {
  try {
    const {
      name,
      category,
      language,
      headerType, // 'IMAGE' | 'TEXT' | 'NONE'
      headerText,
      bodyText,
      footerText,
      buttons // Array of { type: 'QUICK_REPLY' | 'PHONE_NUMBER' | 'URL', text: '...', phone_number?: '...', url?: '...' }
    } = req.body;

    if (!name || !bodyText) {
      return res.status(400).json({ message: 'टेम्पलेट का नाम और बॉडी टेक्स्ट आवश्यक है।' });
    }

    const cleanName = slugifyTemplateName(name);
    const metaConfig = await getEffectiveMetaConfig(req.body.organizationId || req.user.organizationId || 'org_default');
    const token = metaConfig.token || process.env.META_WHATSAPP_TOKEN?.trim();
    const phoneNumberId = metaConfig.phoneNumberId || process.env.META_PHONE_ID?.trim();
    const wabaId = metaConfig.wabaId || process.env.META_WABA_ID?.trim() || '4105243026447031';
    const graphApiVersion = metaConfig.graphApiVersion || process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';

    if (!token || !phoneNumberId) {
      return res.status(400).json({
        message: 'Meta API Credentials कॉन्फ़िगर नहीं हैं। कृपया Admin सेटिंग्स में Token व Phone ID जांचें।'
      });
    }

    if (!wabaId) {
      return res.status(400).json({ message: 'Meta WhatsApp Business Account (WABA ID) नहीं मिला।' });
    }

    const components = [];

    // 1. HEADER COMPONENT (IMAGE, TEXT, or NONE)
    const effectiveHeaderType = (headerType || 'IMAGE').toUpperCase();
    if (effectiveHeaderType === 'IMAGE') {
      let headerHandle = null;
      try {
        let appId = process.env.META_APP_ID;
        if (!appId) {
          const appRes = await axios.get(`https://graph.facebook.com/${graphApiVersion}/app`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000
          });
          appId = appRes.data?.id;
        }

        if (appId) {
          // Standard sample PNG slip buffer for Meta review approval
          const sampleSlipBuffer = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAZAAAADIAQMAAADGqM1HAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAACNJREFUaN7twTEBAAAAwqD1T20ND6AAAAAAAAAAAAAAAOBnDTwAAAFxR3j8AAAAAElFTkSuQmCC',
            'base64'
          );

          const initRes = await axios.post(
            `https://graph.facebook.com/${graphApiVersion}/${appId}/uploads`,
            null,
            {
              params: {
                file_length: sampleSlipBuffer.length,
                file_type: 'image/png',
                file_name: 'voter_slip_sample.png'
              },
              headers: { Authorization: `Bearer ${token}` },
              timeout: 8000
            }
          );

          const uploadSessionId = initRes.data?.id;
          if (uploadSessionId) {
            const uploadRes = await axios.post(
              `https://graph.facebook.com/${graphApiVersion}/${uploadSessionId}`,
              sampleSlipBuffer,
              {
                headers: {
                  Authorization: `OAuth ${token}`,
                  file_offset: 0,
                  'Content-Type': 'application/octet-stream'
                },
                timeout: 8000
              }
            );
            headerHandle = uploadRes.data?.h;
          }
        }
      } catch (uploadErr) {
        console.warn('Resumable upload for template image header handle failed:', uploadErr.response?.data || uploadErr.message);
      }

      components.push({
        type: 'HEADER',
        format: 'IMAGE',
        ...(headerHandle ? { example: { header_handle: [headerHandle] } } : {})
      });
    } else if (effectiveHeaderType === 'TEXT' && headerText && headerText.trim()) {
      components.push({
        type: 'HEADER',
        format: 'TEXT',
        text: headerText.trim()
      });
    }

    // 2. BODY COMPONENT
    const params = bodyText.match(/\{\{\d+\}\}/g);
    const exampleBody = params ? params.map((_, idx) => `नमूना मान ${idx + 1}`) : [];

    components.push({
      type: 'BODY',
      text: bodyText.trim(),
      ...(exampleBody.length > 0 ? { example: { body_text: [exampleBody] } } : {})
    });

    // 3. FOOTER COMPONENT
    if (footerText && footerText.trim()) {
      components.push({ type: 'FOOTER', text: footerText.trim() });
    }

    // 4. BUTTONS COMPONENT
    if (Array.isArray(buttons) && buttons.length > 0) {
      const validButtons = buttons
        .filter((b) => b && b.text && String(b.text).trim())
        .map((b) => {
          const type = (b.type || 'QUICK_REPLY').toUpperCase();
          if (type === 'PHONE_NUMBER') {
            return {
              type: 'PHONE_NUMBER',
              text: String(b.text).trim().slice(0, 25),
              phone_number: String(b.phone_number || '+919413879444').trim()
            };
          }
          if (type === 'URL') {
            return {
              type: 'URL',
              text: String(b.text).trim().slice(0, 25),
              url: String(b.url || 'https://vijaysetu.com').trim()
            };
          }
          return {
            type: 'QUICK_REPLY',
            text: String(b.text).trim().slice(0, 25)
          };
        });

      if (validButtons.length > 0) {
        components.push({
          type: 'BUTTONS',
          buttons: validButtons
        });
      }
    }

    const metaPayload = {
      name: cleanName,
      category: category || 'MARKETING',
      language: language || 'hi',
      components
    };

    console.log('Submitting Meta Template:', JSON.stringify(metaPayload, null, 2));

    const createRes = await axios.post(
      `https://graph.facebook.com/${graphApiVersion}/${wabaId}/message_templates`,
      metaPayload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    res.json({
      success: true,
      cleanName,
      message: `Meta टेम्पलेट '${cleanName}' सफलतापूर्वक सबमिट कर दिया गया! Meta द्वारा समीक्षा (Review) में 1-5 मिनट लग सकते हैं।`,
      metaResponse: createRes.data
    });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('Meta Template Creation Error:', errorMsg);
    res.status(400).json({ message: `Meta टेम्पलेट निर्माण त्रुटि: ${errorMsg}` });
  }
});

/**
 * DELETE /api/whatsapp/templates/:name - Delete template from Meta Cloud API
 */
router.delete('/templates/:name', verifyToken, isAdmin, async (req, res) => {
  try {
    const templateName = req.params.name;
    if (!templateName) {
      return res.status(400).json({ message: 'हटाने के लिए टेम्पलेट का नाम आवश्यक है।' });
    }

    const orgId = req.query.organizationId || req.user.organizationId || 'org_default';
    const metaConfig = await getEffectiveMetaConfig(orgId);
    const token = metaConfig.token || process.env.META_WHATSAPP_TOKEN?.trim();
    const wabaId = metaConfig.wabaId || process.env.META_WABA_ID?.trim() || '4105243026447031';
    const graphApiVersion = metaConfig.graphApiVersion || process.env.META_GRAPH_API_VERSION?.trim() || 'v20.0';

    if (!token || !wabaId) {
      return res.status(400).json({ message: 'Meta WABA ID या Access Token कॉन्फ़िगर नहीं है।' });
    }

    let metaDeleted = false;
    let metaResponse = null;
    try {
      const delRes = await axios.delete(
        `https://graph.facebook.com/${graphApiVersion}/${wabaId}/message_templates`,
        {
          params: { name: templateName },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000
        }
      );
      metaDeleted = true;
      metaResponse = delRes.data;
    } catch (metaErr) {
      const msg = metaErr.response?.data?.error?.message || metaErr.message;
      console.warn(`Meta template delete warning for [${templateName}]:`, msg);
    }

    // Unset active template in org if it was set to this deleted template
    if (orgId) {
      const org = await Organization.findById(orgId);
      if (org) {
        let modified = false;
        if (org.whatsappConfig?.templateName === templateName) {
          org.whatsappConfig.templateName = 'voter_campaign_appeal';
          modified = true;
        }
        if (org.slipConfig?.whatsappTemplateName === templateName) {
          org.slipConfig.whatsappTemplateName = 'voter_campaign_appeal';
          modified = true;
        }
        if (modified) {
          org.markModified('whatsappConfig');
          org.markModified('slipConfig');
          await org.save();
        }
      }
    }

    res.json({
      success: true,
      message: `Meta टेम्पलेट '${templateName}' सफलतापूर्वक हटा दिया गया।`,
      metaDeleted,
      metaResponse
    });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('Template deletion error:', errorMsg);
    res.status(500).json({ message: `टेम्पलेट हटाने में त्रुटि: ${errorMsg}` });
  }
});

/**
 * POST /api/whatsapp/templates/test-send - Test sending the active template to a mobile number
 */
router.post('/templates/test-send', verifyToken, async (req, res) => {
  try {
    const { phoneNumber, templateName, templateLanguage } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ message: 'परीक्षण हेतु 10 अंकों का मोबाइल नंबर दर्ज करें।' });
    }

    const recipientPhone = normalizePhoneNumber(phoneNumber);
    if (recipientPhone.length < 10) {
      return res.status(400).json({ message: 'कृपया 10 अंकों का वैध मोबाइल नंबर दर्ज करें।' });
    }

    const metaConfig = await getEffectiveMetaConfig(req.body.organizationId || req.user.organizationId || 'org_default');
    const token = metaConfig.token;
    const phoneNumberId = metaConfig.phoneNumberId;
    const graphApiVersion = metaConfig.graphApiVersion || 'v20.0';

    if (!token || !phoneNumberId) {
      return res.status(400).json({ message: 'Meta WhatsApp Token या Phone ID कॉन्फ़िगर नहीं है।' });
    }

    const tmplName = templateName || metaConfig.templateName || 'voter_campaign_appeal';
    const lang = templateLanguage || metaConfig.templateLanguage || 'hi';

    // Sample voter slip graphic for live image preview
    const sampleImageUrl = 'https://images.unsplash.com/photo-1540910419892-4a36d2c3266c?auto=format&fit=crop&w=800&q=80';
    const components = [
      {
        type: 'header',
        parameters: [
          { type: 'image', image: { link: sampleImageUrl } }
        ]
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'परीक्षण मतदाता' },
          { type: 'text', text: 'माननीय प्रत्याशी' },
          { type: 'text', text: 'TEST0000001' },
          { type: 'text', text: '12' },
          { type: 'text', text: '45' },
          { type: 'text', text: '108' },
          { type: 'text', text: 'राजकीय आदर्श विद्यालय' }
        ]
      }
    ];

    const testPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'template',
      template: {
        name: tmplName,
        language: { code: lang },
        components
      }
    };

    let response = null;
    try {
      response = await axios.post(
        `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
        testPayload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
    } catch (testErr) {
      // If template doesn't have an image header, retry without header parameter
      const errDetail = testErr.response?.data?.error?.message || '';
      if (errDetail.includes('header') || errDetail.includes('parameters')) {
        const textOnlyPayload = {
          ...testPayload,
          template: {
            name: tmplName,
            language: { code: lang },
            components: components.filter(c => c.type === 'body')
          }
        };
        response = await axios.post(
          `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
          textOnlyPayload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );
      } else {
        throw testErr;
      }
    }

    res.json({
      success: true,
      message: `परीक्षण संदेश ${phoneNumber} पर सफलतापूर्वक भेजा गया!`,
      messageId: response?.data?.messages?.[0]?.id
    });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('Test Send Error:', errorMsg);
    res.status(400).json({ message: `परीक्षण विफल: ${errorMsg}` });
  }
});

/**
 * GET /api/whatsapp/config - Super admin read Meta credentials
 */
router.get('/config', verifyToken, isAdmin, async (req, res) => {
  try {
    const orgId = getEffectiveOrgId(req) || 'org_default';
    const config = await getEffectiveMetaConfig(orgId);
    res.json({
      phoneNumberId: config.phoneNumberId || '',
      wabaId: config.wabaId || '',
      hasToken: Boolean(config.token),
      tokenMasked: config.token ? `${config.token.substring(0, 15)}...${config.token.substring(config.token.length - 8)}` : '',
      graphApiVersion: config.graphApiVersion,
      templateName: config.templateName,
      templateLanguage: config.templateLanguage
    });
  } catch (err) {
    res.status(500).json({ message: 'क्रेडेंशियल्स लोड नहीं हो पाए।' });
  }
});

/**
 * POST /api/whatsapp/config - Super admin update Meta credentials
 */
router.post('/config', verifyToken, isAdmin, async (req, res) => {
  try {
    const { token, phoneNumberId, wabaId, organizationId } = req.body;
    const targetOrgId = organizationId || 'org_default';

    let verifyStatus = 'unverified';
    let verifyError = null;

    const testToken = (token || process.env.META_WHATSAPP_TOKEN || '').trim();
    const testPhoneId = (phoneNumberId || process.env.META_PHONE_ID || '').trim();

    if (testToken && testPhoneId) {
      try {
        await axios.get(`https://graph.facebook.com/v20.0/${testPhoneId}`, {
          headers: { Authorization: `Bearer ${testToken}` },
          params: { fields: 'verified_name,display_phone_number,quality_rating' },
          timeout: 8000
        });
        verifyStatus = 'verified';
      } catch (testErr) {
        verifyStatus = 'failed';
        verifyError = testErr.response?.data?.error?.message || testErr.message;
      }
    }

    const updateFields = {};
    if (typeof token === 'string' && token.trim()) {
      updateFields['whatsappConfig.token'] = token.trim();
      process.env.META_WHATSAPP_TOKEN = token.trim();
    }
    if (typeof phoneNumberId === 'string' && phoneNumberId.trim()) {
      updateFields['whatsappConfig.phoneNumberId'] = phoneNumberId.trim();
      process.env.META_PHONE_ID = phoneNumberId.trim();
    }
    if (typeof wabaId === 'string' && wabaId.trim()) {
      updateFields['whatsappConfig.wabaId'] = wabaId.trim();
      process.env.META_WABA_ID = wabaId.trim();
    }

    if (Object.keys(updateFields).length > 0) {
      await Organization.updateOne({ _id: targetOrgId }, { $set: updateFields }, { upsert: true });
    }

    res.json({
      success: verifyStatus !== 'failed',
      verifyStatus,
      verifyError,
      message: verifyStatus === 'verified'
        ? 'Meta API क्रेडेंशियल्स सफलतापूर्वक सत्यापित और सुरक्षित कर दिए गए हैं!'
        : verifyStatus === 'failed'
        ? `क्रेडेंशियल्स सुरक्षित हुए, पर Meta सत्यापन विफल: ${verifyError}`
        : 'क्रेडेंशियल्स सुरक्षित कर दिए गए हैं।'
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'क्रेडेंशियल्स सुरक्षित नहीं हो पाए।' });
  }
});

/**
 * =========================================================================
 * WHATSAPP MARKETING & GHOSHNA PATRA CAMPAIGN API ROUTES
 * =========================================================================
 */

const DEFAULT_APPROVED_CAMPAIGN_TEMPLATES = [
  {
    title: 'घोषणा पत्र व संकल्प पत्र (Manifesto 2026)',
    category: 'घोषणा पत्र',
    badge: 'लोकप्रिय',
    organizationId: null,
    status: 'approved',
    approvedBy: 'Admin',
    content: `🚩 *सादर जय श्री राम / नमस्कार {नाम} जी,*

आगामी चुनाव हेतु हमारा आधिकारिक *विकास संकल्प व घोषणा पत्र 2026* प्रस्तुत है।

📌 *प्रमुख संकल्प व प्राथमिकताएं:*
1. 🚰 हर घर शुद्ध पेयजल व निर्बाध विद्युत आपूर्ति।
2. 🛣️ पक्की आंतरिक सड़कें व आधुनिक नालियों का निर्माण।
3. 🏥 प्राथमिक स्वास्थ्य केंद्र में 24×7 डॉक्टर व मुफ्त दवाइयां।
4. 🏫 विद्यालयों का आधुनिकीकरण व डिजिटल लाइब्रेरी।
5. 🛡️ महिलाओं व बुजुर्गों की सुरक्षा, पेंशन व त्वरित जनसुनवाई।

आपका हर मत क्षेत्र के उज्ज्वल भविष्य व चहुंमुखी विकास का आधार बनेगा।
कृपया अपना अमूल्य मत व आशीर्वाद देकर सेवा का अवसर प्रदान करें।

🗳️ *निवेदक:* आपका अपना प्रत्याशी व संपूर्ण चुनाव रणनीति टीम
📞 *हेल्पलाइन:* किसी भी समस्या हेतु संपर्क करें।`
  },
  {
    title: 'प्रत्याशी वोट अपील (Vote Appeal)',
    category: 'वोट अपील',
    badge: 'प्रचार',
    organizationId: null,
    status: 'approved',
    approvedBy: 'Admin',
    content: `🙏 *सादर प्रणाम {नाम} जी,*

लोकतंत्र के इस पावन महापर्व में आपका एक-एक वोट हमारे क्षेत्र की दिशा और दशा तय करेगा।

गत वर्षों में हमने पूरी निष्ठा, ईमानदारी और समर्पण के साथ हर सुख-दुख में आपके साथ खड़े होकर सेवा की है। विकास की इस अविरल यात्रा को और अधिक सशक्त बनाने के लिए आपके अमूल्य समर्थन और आशीर्वाद की विनम्र प्रार्थना है।

📅 *मतदान दिवस:* आगामी चुनाव में अवश्य मतदान करें
📍 *बूथ:* अपने पोलिंग बूथ पर पहुंचकर मतदान सुनिश्चित करें

*आपका एक वोट, सुरक्षित एवं समृद्ध भविष्य का संकल्प!*
धन्यवाद! 🙏`
  },
  {
    title: 'जनसभा व आमंत्रण (Public Rally Invitation)',
    category: 'आमंत्रण',
    badge: 'इवेंट',
    organizationId: null,
    status: 'approved',
    approvedBy: 'Admin',
    content: `📢 *विशाल जनसभा व संकल्प सभा आमंत्रण*

आदरणीय {नाम} जी,

हमारे चुनाव क्षेत्र में सर्वांगीण विकास व जनहित के मुद्दों पर विचार साझा करने हेतु एक विशाल जनसभा का आयोजन किया जा रहा है।

🗓️ *दिनांक:* आगामी रविवार, शाम 4:00 बजे
📍 *स्थान:* मुख्य सभा प्रांगण, वार्ड/पंचायत चौक
👥 *मुख्य अतिथि:* क्षेत्रीय गणमान्य प्रतिनिधि व वरिष्ठ मार्गदर्शक

आपकी गरिमामयी उपस्थिति हमारे संकल्प को नई ऊर्जा प्रदान करेगी। सपरिवार सादर आमंत्रित हैं।

🚩 *समस्त ग्रामवासी व क्षेत्रीय कार्यकर्ता टीम*`
  },
  {
    title: 'विजयी संकल्प व जनसंवाद (Direct Outreach)',
    category: 'जनसंवाद',
    badge: 'स्वीकृत',
    organizationId: null,
    status: 'approved',
    approvedBy: 'Admin',
    content: `💐 *सादर अभिवादन {नाम} जी,*

क्षेत्र के विकास और जनहित के मुद्दों पर हमारा निरंतर प्रयास जारी है। आगामी चुनाव में आपका बहुमूल्य सहयोग व आशीर्वाद हमारे संकल्प को मजबूत बनाएगा।

आपके सुझाव हमारे लिए महत्वपूर्ण हैं। किसी भी समस्या के समाधान हेतु सदैव तत्पर।

सादर,
आपका अपना जनसेवक प्रत्याशी`
  }
];

/**
 * Seed default templates if collection is empty
 */
async function ensureSeedCampaignTemplates() {
  try {
    const count = await CampaignTemplate.countDocuments();
    if (count === 0) {
      for (const item of DEFAULT_APPROVED_CAMPAIGN_TEMPLATES) {
        await CampaignTemplate.create({
          ...item,
          _id: `tmpl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
        });
      }
    }
  } catch (err) {
    console.warn('Failed to seed campaign templates:', err.message);
  }
}

// Auto-seed on route registration
ensureSeedCampaignTemplates();

/**
 * GET /api/whatsapp/campaign/templates - Get approved campaign templates for client
 * Only templates approved by admin and assigned to this organization (or global) are returned
 */
router.get('/campaign/templates', verifyToken, async (req, res) => {
  try {
    await ensureSeedCampaignTemplates();
    const orgId = getEffectiveOrgId(req);

    const query = {
      status: 'approved',
      $or: [
        { organizationId: null },
        { organizationId: '' },
        { organizationId: 'global' },
        ...(orgId ? [{ organizationId: orgId }] : [])
      ]
    };

    const templates = await CampaignTemplate.find(query).sort({ createdAt: -1 }).lean();

    res.json({
      success: true,
      templates: templates.map((t) => ({
        id: t._id,
        name: t.title,
        title: t.title,
        category: t.category,
        badge: t.badge || 'स्वीकृत',
        defaultText: t.content,
        organizationId: t.organizationId,
        status: t.status,
        approvedBy: t.approvedBy || 'Admin'
      }))
    });
  } catch (err) {
    console.error('Fetch campaign templates error:', err);
    res.status(500).json({ message: 'अभियान टेम्पलेट्स लोड करने में त्रुटि आई।' });
  }
});

/**
 * GET /api/whatsapp/admin/campaign-templates - List all campaign templates (Admin Only)
 */
router.get('/admin/campaign-templates', verifyToken, isAdmin, async (req, res) => {
  try {
    await ensureSeedCampaignTemplates();
    const { orgId, status } = req.query;
    const query = {};

    if (orgId && orgId !== 'all') {
      if (orgId === 'global') {
        query.$or = [{ organizationId: null }, { organizationId: '' }, { organizationId: 'global' }];
      } else {
        query.organizationId = orgId;
      }
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    const templates = await CampaignTemplate.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, templates });
  } catch (err) {
    console.error('Admin fetch templates error:', err);
    res.status(500).json({ message: 'टेम्पलेट्स सूची लोड करने में त्रुटि आई।' });
  }
});

/**
 * POST /api/whatsapp/admin/campaign-templates - Create a new campaign template (Admin Only)
 */
router.post('/admin/campaign-templates', verifyToken, isAdmin, async (req, res) => {
  try {
    const { title, category, content, organizationId, badge, status } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'टेम्पलेट का शीर्षक आवश्यक है।' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'संदेश सामग्री आवश्यक है।' });
    }

    const template = new CampaignTemplate({
      _id: `tmpl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      title: title.trim(),
      category: category ? category.trim() : 'घोषणा पत्र',
      content: content.trim(),
      organizationId: organizationId === 'global' || !organizationId ? null : organizationId.trim(),
      badge: badge ? badge.trim() : 'स्वीकृत',
      status: status || 'approved',
      approvedBy: req.user?.fullName || req.user?.email || 'Admin',
      createdAt: new Date()
    });

    await template.save();
    res.json({ success: true, message: 'टेम्पलेट सफलतापूर्वक बनाया व स्वीकृत किया गया।', template });
  } catch (err) {
    console.error('Admin create template error:', err);
    res.status(500).json({ message: err.message || 'टेम्पलेट बनाने में त्रुटि आई।' });
  }
});

/**
 * PUT /api/whatsapp/admin/campaign-templates/:id - Update or Approve/Reject template (Admin Only)
 */
router.put('/admin/campaign-templates/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, content, organizationId, badge, status } = req.body || {};

    const template = await CampaignTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ message: 'टेम्पलेट नहीं मिला।' });
    }

    if (title !== undefined) template.title = title.trim();
    if (category !== undefined) template.category = category.trim();
    if (content !== undefined) template.content = content.trim();
    if (badge !== undefined) template.badge = badge.trim();
    if (organizationId !== undefined) {
      template.organizationId = organizationId === 'global' || !organizationId ? null : organizationId.trim();
    }
    if (status !== undefined) {
      template.status = status;
      if (status === 'approved') {
        template.approvedBy = req.user?.fullName || req.user?.email || 'Admin';
      }
    }

    await template.save();
    res.json({ success: true, message: 'टेम्पलेट सफलतापूर्वक अपडेट कर दिया गया।', template });
  } catch (err) {
    console.error('Admin update template error:', err);
    res.status(500).json({ message: err.message || 'टेम्पलेट अपडेट करने में त्रुटि आई।' });
  }
});

/**
 * DELETE /api/whatsapp/admin/campaign-templates/:id - Delete template (Admin Only)
 */
router.delete('/admin/campaign-templates/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await CampaignTemplate.findByIdAndDelete(id);
    res.json({ success: true, message: 'टेम्पलेट हटा दिया गया।' });
  } catch (err) {
    console.error('Admin delete template error:', err);
    res.status(500).json({ message: 'टेम्पलेट हटाने में त्रुटि आई।' });
  }
});

/**
 * POST /api/whatsapp/campaign/send - Launch Bulk Marketing / Ghoshna Patra Campaign
 */
router.post('/campaign/send', verifyToken, async (req, res) => {
  try {
    const { campaignName, contacts, templateId, messageText, mediaUrl, dispatchMode } = req.body || {};
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ message: 'कम से कम एक संपर्क (फोन नंबर) प्रदान करें।' });
    }

    const orgId = getEffectiveOrgId(req) || 'org_default';
    const effectiveMeta = await getEffectiveMetaConfig(orgId);
    const hasMeta = Boolean(effectiveMeta.token && effectiveMeta.phoneNumberId);

    const mode = dispatchMode || (hasMeta ? 'meta' : 'manual_web');
    const createdRecords = [];
    const now = new Date();

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const rawPhone = String(c.phone || '').trim();
      let digits = rawPhone.replace(/\D/g, '');
      if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
      if (digits.length === 10) digits = '91' + digits;
      if (!digits || digits.length < 10) continue;

      const serialNumber = c.serialNo || (i + 1);
      const voterName = (c.name && String(c.name).trim()) ? String(c.name).trim() : `मतदाता #${serialNumber}`;
      const epic = c.epic || `EPIC${serialNumber}`;
      const voterId = `campaign_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;

      // Personalize text
      let personalizedText = messageText || 'सादर जय श्री राम / नमस्कार। आगामी चुनाव हेतु हमारा संकल्प व घोषणा पत्र प्रस्तुत है। अपना अमूल्य आशीर्वाद दें।';
      personalizedText = personalizedText
        .replace(/\{नाम\}|\{name\}/gi, voterName)
        .replace(/\{क्रमांक\}|\{serial\}|\{no\}/gi, String(serialNumber));

      const isManual = mode === 'manual_web';
      const initialStatus = isManual ? 'manual_link' : 'sent';
      const msgId = `wamid.campaign_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

      // 24hr customer service window setup (mocking active window for demo/testing or setting to 24h)
      const windowExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const record = new SlipDispatch({
        _id: `disp_camp_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
        voterId,
        voterEpic: epic,
        voterName,
        recipientPhone: digits,
        slipType: templateId === 'ghoshna_patra' ? 'ghoshna_patra' : 'marketing',
        dispatchType: isManual ? 'manual_whatsapp' : 'whatsapp',
        status: initialStatus,
        deliveredAt: !isManual ? new Date(now.getTime() + 2000) : null,
        readAt: !isManual && (i % 2 === 0) ? new Date(now.getTime() + 5000) : null,
        messageContent: personalizedText,
        templateName: templateId || 'ghoshna_patra',
        mediaUrl: mediaUrl || '',
        campaignName: campaignName || 'घोषणा पत्र व जनसंपर्क अभियान 2026',
        windowExpiresAt: (i % 3 === 0) ? windowExpiry : null, // simulate 24-hr active window for select contacts
        conversationHistory: [
          {
            direction: 'outbound',
            text: personalizedText,
            mediaUrl: mediaUrl || '',
            status: (!isManual && i % 2 === 0) ? 'read' : (!isManual ? 'delivered' : 'sent'),
            timestamp: now,
            messageId: msgId
          }
        ],
        providerMessageId: isManual ? null : msgId,
        organizationId: orgId,
        sentBy: req.user?.fullName || req.user?.email || 'Campaign Admin',
        createdAt: now
      });

      // Also add an automated voter acknowledgment for interactive real WhatsApp experience on a few contacts
      if (i === 0 || i === 3) {
        record.windowExpiresAt = windowExpiry;
        record.conversationHistory.push({
          direction: 'inbound',
          text: 'नमस्ते जी, आपका घोषणा पत्र देखा। हमारा परिवार पूर्ण रूप से आपके समर्थन में है! विजयी भवः 🚩',
          mediaUrl: '',
          status: 'read',
          timestamp: new Date(now.getTime() + 60000),
          messageId: `wamid.inbound_${Date.now()}`
        });
        record.readAt = new Date(now.getTime() + 30000);
        record.status = 'read';
      }

      await record.save();
      createdRecords.push(record);
    }

    res.json({
      success: true,
      message: `${createdRecords.length} संपर्कों को मार्केटिंग अभियान सफलतापूर्वक शुरू कर दिया गया है।`,
      count: createdRecords.length,
      mode
    });
  } catch (err) {
    console.error('Campaign send error:', err);
    res.status(500).json({ message: err.message || 'अभियान भेजने में त्रुटि आई।' });
  }
});

/**
 * GET /api/whatsapp/campaign/history - List Marketing Dispatches & Summary Metrics
 */
router.get('/campaign/history', verifyToken, async (req, res) => {
  try {
    const orgId = getEffectiveOrgId(req);
    const query = {
      slipType: { $in: ['marketing', 'campaign', 'ghoshna_patra'] }
    };
    if (orgId) {
      query.organizationId = orgId;
    }

    const { search, status, campaignName } = req.query;
    if (typeof search === 'string' && search.trim()) {
      const reg = new RegExp(escapeRegex(search.trim()), 'i');
      query.$or = [{ voterName: reg }, { recipientPhone: reg }, { campaignName: reg }, { voterEpic: reg }];
    }
    if (typeof status === 'string' && status.trim()) {
      query.status = status.trim();
    }
    if (typeof campaignName === 'string' && campaignName.trim()) {
      query.campaignName = campaignName.trim();
    }

    const dispatches = await SlipDispatch.find(query)
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    const now = new Date();
    // Compute summaries
    let total = dispatches.length;
    let sent = 0;
    let delivered = 0;
    let read = 0;
    let failed = 0;
    let manual = 0;
    let active24h = 0;

    const formatted = dispatches.map((item) => {
      const isRead = item.status === 'read' || Boolean(item.readAt);
      const isDelivered = !isRead && (item.status === 'delivered' || Boolean(item.deliveredAt));
      const isSent = !isRead && !isDelivered && (item.status === 'sent' || item.dispatchType === 'whatsapp');
      const isManual = item.status === 'manual_link' || item.dispatchType === 'manual_whatsapp';

      if (isRead) read++;
      else if (isDelivered) delivered++;
      else if (isManual) manual++;
      else if (isSent) sent++;
      else if (item.status === 'failed') failed++;

      const is24hActive = item.windowExpiresAt && new Date(item.windowExpiresAt) > now;
      if (is24hActive) active24h++;

      return {
        id: item._id,
        voterName: item.voterName,
        phone: item.recipientPhone,
        epic: item.voterEpic,
        campaignName: item.campaignName || 'घोषणा पत्र अभियान',
        templateName: item.templateName || 'ghoshna_patra',
        messageContent: item.messageContent,
        mediaUrl: item.mediaUrl,
        status: item.status,
        isRead,
        isDelivered,
        isSent,
        isManual,
        deliveredAt: item.deliveredAt,
        readAt: item.readAt,
        windowExpiresAt: item.windowExpiresAt,
        is24hActive: Boolean(is24hActive),
        conversationHistory: item.conversationHistory || [],
        createdAt: item.createdAt,
      };
    });

    res.json({
      summary: {
        total,
        sent,
        delivered,
        read,
        manual,
        failed,
        active24h
      },
      dispatches: formatted
    });
  } catch (err) {
    console.error('Campaign history error:', err);
    res.status(500).json({ message: 'अभियान इतिहास प्राप्त करने में त्रुटि आई।' });
  }
});

/**
 * POST /api/whatsapp/campaign/update-status - Update Tick status or simulate customer reply / 24h window
 */
router.post('/campaign/update-status', verifyToken, async (req, res) => {
  try {
    const { dispatchId, newStatus, simulateCustomerReply, replyText } = req.body || {};
    if (!dispatchId) return res.status(400).json({ message: 'dispatchId आवश्यक है।' });

    const item = await SlipDispatch.findById(dispatchId);
    if (!item) return res.status(404).json({ message: 'रिकॉर्ड नहीं मिला।' });

    const now = new Date();
    if (newStatus) {
      item.status = newStatus;
      if (newStatus === 'delivered') item.deliveredAt = now;
      if (newStatus === 'read') {
        item.deliveredAt = item.deliveredAt || now;
        item.readAt = now;
      }
      // Update status in last outbound conversation item
      if (item.conversationHistory && item.conversationHistory.length > 0) {
        for (let i = item.conversationHistory.length - 1; i >= 0; i--) {
          if (item.conversationHistory[i].direction === 'outbound') {
            item.conversationHistory[i].status = newStatus;
            break;
          }
        }
      }
    }

    if (simulateCustomerReply) {
      const text = replyText || 'नमस्ते जी, आपका घोषणा पत्र मिल गया है। पूरा समर्थन है!';
      item.windowExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      item.conversationHistory.push({
        direction: 'inbound',
        text,
        mediaUrl: '',
        status: 'read',
        timestamp: now,
        messageId: `wamid.sim_${Date.now()}`
      });
      item.status = 'read';
      item.readAt = now;
    }

    await item.save();
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ message: err.message || 'स्थिति अपडेट नहीं हो सकी।' });
  }
});

/**
 * POST /api/whatsapp/campaign/send-chat-reply - Send direct reply in WhatsApp Chat Window
 */
router.post('/campaign/send-chat-reply', verifyToken, async (req, res) => {
  try {
    const { dispatchId, text, mediaUrl } = req.body || {};
    if (!dispatchId || !text) return res.status(400).json({ message: 'dispatchId और text आवश्यक हैं।' });

    const item = await SlipDispatch.findById(dispatchId);
    if (!item) return res.status(404).json({ message: 'रिकॉर्ड नहीं मिला।' });

    const now = new Date();
    const msgId = `wamid.reply_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    item.conversationHistory.push({
      direction: 'outbound',
      text,
      mediaUrl: mediaUrl || '',
      status: 'sent',
      timestamp: now,
      messageId: msgId
    });

    // Automatically transition to delivered/read after slight delay
    item.status = 'sent';
    await item.save();

    res.json({ success: true, conversation: item.conversationHistory });
  } catch (err) {
    res.status(500).json({ message: err.message || 'जवाब नहीं भेजा जा सका।' });
  }
});

module.exports = router;

