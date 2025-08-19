// Add this import at the top of your file
const admin = require('firebase-admin');

// Load the service account from an environment variable
// You will set this up on Render later
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const express = require('express');

ffmpeg.setFfmpegPath(ffmpegPath);

// ====== CONFIG ======
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;

// ====== LOAD / SAVE GLOBAL SETTINGS ======
let SETTINGS = {
  defaultPack: 'YOUSSEF',
  defaultAuthor: 'IG: ussef.elabassi',
  requireCaption: false,
};

async function loadSettings() {
  const doc = await db.collection('settings').doc('global').get();
  if (doc.exists) {
    SETTINGS = { ...SETTINGS, ...doc.data() };
  } else {
    // If not exists, create it with default values
    await db.collection('settings').doc('global').set(SETTINGS);
  }
}

async function saveSettings(newSettings) {
  try {
    await db.collection('settings').doc('global').set(newSettings);
    SETTINGS = newSettings; // Update the in-memory settings
  } catch (e) {
    console.error('Failed to save global settings:', e);
  }
}

// ====== PER-USER CREDITS PERSISTENCE ======
let USER_SETTINGS = {};

async function loadUserSettings() {
    const snapshot = await db.collection('users').get();
    snapshot.forEach(doc => {
        USER_SETTINGS[doc.id] = doc.data();
    });
}

async function saveUserSettings(userId, settings) {
  try {
    await db.collection('users').doc(userId).set(settings, { merge: true });
  } catch (e) {
    console.error('Failed to save user settings:', e);
  }
}

function getUserId(msg) {
  // DM: msg.from ends with @c.us, group: use msg.author if present
  if (msg.from && msg.from.endsWith('@c.us')) return msg.from;
  return msg.author || msg.from;
}
function getCreditsFor(msg) {
  const id = getUserId(msg);
  const rec = USER_SETTINGS[id] || {};
  return {
    name:   rec.name   || SETTINGS.defaultPack,
    author: rec.author || SETTINGS.defaultAuthor,
  };
}
async function setPackName(msg, value) {
  const id = getUserId(msg);
  USER_SETTINGS[id] = USER_SETTINGS[id] || {};
  USER_SETTINGS[id].name = value || SETTINGS.defaultPack;
  await saveUserSettings(id, USER_SETTINGS[id]);
}
async function setAuthor(msg, value) {
  const id = getUserId(msg);
  USER_SETTINGS[id] = USER_SETTINGS[id] || {};
  USER_SETTINGS[id].author = value || SETTINGS.defaultAuthor;
  await saveUserSettings(id, USER_SETTINGS[id]);
}

// ====== CAPTION FLAGS ======
const hasWord = (txt, w) => new RegExp(`\\b${w}\\b`, 'i').test(txt || '');
const wantsSticker = (t='') => hasWord(t, 'sticker'); // used if requireCaption=true
const wantsSquare  = (t='') => /\bcrop\b/i.test(t || '');
const wantsRbg     = (t='') => hasWord(t, 'rbg');

// ====== IMAGE PROCESSORS ======
async function removeBgFromImage(messageMedia /* MessageMedia */) {
  const res = await axios.post(
    'https://api.remove.bg/v1.0/removebg',
    { image_file_b64: messageMedia.data, size: 'auto' },
    { headers: { 'X-Api-Key': REMOVE_BG_API_KEY }, responseType: 'arraybuffer' }
  );
  if (res.status !== 200) throw new Error(`remove.bg failed: ${res.status} ${res.statusText}`);
  const outB64 = Buffer.from(res.data).toString('base64');
  return new MessageMedia('image/png', outB64, 'nobg.png');
}

async function cropImageToSquare(messageMedia /* MessageMedia */) {
  const buf = Buffer.from(messageMedia.data, 'base64');
  const img = sharp(buf, { animated: false });
  const meta = await img.metadata();
  const side = Math.min(meta.width || 0, meta.height || 0);
  if (!side) throw new Error('Cannot read image size');

  const outBuf = await img
    .resize(side, side, { fit: 'cover', position: 'centre' })
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  return new MessageMedia('image/png', outBuf.toString('base64'), 'square.png');
}

async function clampImageSize(messageMedia /* MessageMedia */) {
  const buf = Buffer.from(messageMedia.data, 'base64');
  const outBuf = await sharp(buf, { animated: false })
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return new MessageMedia('image/png', outBuf.toString('base64'), 'resized.png');
}

// ====== VIDEO/GIF PROCESSOR (temp file path) ======
/**
 * Crops a video/GIF to a square, converts it to mp4, and applies other transformations.
 * This is a robust version for your sticker bot project.
 * @param {object} messageMedia A mock object with a `data` property containing base64 video data.
 * @param {object} options Options for cropping.
 * @param {number} options.maxDur The maximum duration in seconds for the output video.
 * @param {number} options.size The size of the square output in pixels.
 * @param {number} options.fps The frames per second for the output video.
 * @returns {Promise<string>} The path to the cropped output video file.
 */
async function cropVideoToSquareFile(messageMedia, { maxDur = 8, size = 512, fps = 15 } = {}) {
  const inFile = path.join(os.tmpdir(), `in_${Date.now()}.mp4`);
  const outFile = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);

  // Write the base64 data to a temporary input file.
  await require('fs').promises.writeFile(inFile, Buffer.from(messageMedia.data, 'base64'));

  // Define the video filter string for ffmpeg.
  const vf = [
    "crop='min(iw,ih)':'min(iw,ih)'",
    `scale=${size}:${size}:flags=lanczos`,
    `fps=${fps}`
  ].join(',');

  return new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .noAudio()
      .videoCodec('libx264')
      .outputOptions([
        '-preset veryfast',
        `-t ${maxDur}`,
        '-movflags +faststart',
        '-pix_fmt yuv420p'
      ])
      .videoFilters(vf)
      .on('error', (err) => {
        console.error('An error occurred during video processing: ' + err.message);
        // Clean up on error before rejecting
        try { require('fs').promises.unlink(inFile).catch(() => {}); } catch {}
        try { require('fs').promises.unlink(outFile).catch(() => {}); } catch {}
        reject(err);
      })
      .on('end', () => {
        resolve(outFile);
      })
      .save(outFile);
  }).finally(async () => {
    // Clean up the temporary input file
    try {
      await require('fs').promises.unlink(inFile);
    } catch (err) {
      console.error('Error cleaning up input file:', err);
    }
  });
}

// ====== CLIENT ======
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wweb-auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  ffmpegPath: ffmpegPath || undefined,
});

// Send sticker (payload can be MessageMedia or file path)
async function sendSticker(msg, payload /* MessageMedia | string */) {
  let mediaObj = payload;
  if (typeof payload === 'string') {
    mediaObj = await MessageMedia.fromFilePath(payload);
  }
  const credits = getCreditsFor(msg);
  await client.sendMessage(msg.from, mediaObj, {
    sendMediaAsSticker: true,
    stickerName: credits.name,
    stickerAuthor: credits.author,
  });
}

// ====== MAIN STICKER FLOW ======
async function replyWithSticker(msg) {
  const caption = msg.body || '';

  // Respect the global mode: require "sticker" in caption or not
  if (SETTINGS.requireCaption && !wantsSticker(caption)) {
    // await msg.reply('ℹ️ Add the word *sticker* in the caption to convert. You can also add *crop* and *rbg* (images only).');
    return;
  }

  // Handle media messages and replied-to media messages
  if (!msg.hasMedia && !msg.hasQuotedMsg) {
    return;
  }
  
  let media = null;
  try {
    media = await msg.downloadMedia();
  } catch (e) {
    // If download fails for the current message, check for a quoted message.
    if (msg.hasQuotedMsg) {
      try {
        const quotedMsg = await msg.getQuotedMessage();
        media = await quotedMsg.downloadMedia();
      } catch (e) {
        console.error('Failed to download media from quoted message:', e);
        await msg.reply('⚠️ Could not download media. Send the media and the caption in the same message or reply directly to the media.');
        return;
      }
    }
  }

  // If we still don't have media, return.
  if (!media) {
    await msg.reply('⚠️ Could not download media. Send the media and the caption in the same message or reply directly to the media.');
    return;
  }


  const doSquare = wantsSquare(caption);
  const doRbg    = wantsRbg(caption);

  const isImage = media.mimetype?.startsWith('image/');
  const isGif   = media.mimetype === 'image/gif';
  const isVideo = media.mimetype?.startsWith('video/');

  try {
    // --- Static images ---
    if (isImage && !isGif) {
      let work = media;

      if (doRbg)   work = await removeBgFromImage(work);

      if (doSquare) {
        work = await cropImageToSquare(work);
      } else {
        work = await clampImageSize(work);
      }

      const mm = new MessageMedia(work.mimetype, work.data, work.filename || 'sticker.png');
      await sendSticker(msg, mm);

      if (doRbg && doSquare) await msg.reply('🪄 Background removed and cropped to 1:1.');
      else if (doRbg)        await msg.reply('🪄 Background removed.');
      else if (doSquare)     await msg.reply('🟩 Cropped to 1:1.');
      return;
    }

    // --- GIF/Video ---
    if (isGif || isVideo) {
      if (doSquare) {
        let outPath = null;
        try {
          outPath = await cropVideoToSquareFile(media, { maxDur: 8, size: 512, fps: 15 });
          await sendSticker(msg, outPath);
          await msg.reply('🟩 Cropped video/GIF to 1:1.');
        } finally {
          // Ensure the output file is cleaned up even if sendSticker fails
          if (outPath) {
            try { await require('fs').promises.unlink(outPath); } catch {}
          }
        }
        return;
      }
      await sendSticker(msg, media);
      return;
    }

    // Fallback
    await sendSticker(msg, media);
  } catch (e) {
    console.error('Sticker processing failed:', e);
    await msg.reply('⚠️ Processing failed. Sending original as sticker.');
    await sendSticker(msg, media);
  }
}

// ====== EVENTS ======
client.on('qr', qr => { console.clear(); qrcode.generate(qr, { small: true }); });
client.on('ready', async () => {
    await loadSettings();
    await loadUserSettings();
    console.log('✅ Bot is ready!');
});

client.on('message', async (msg) => {
  const raw  = msg.body || '';
  const text = raw.trim().toLowerCase();
  const { name, author } = getCreditsFor(msg);

  // Welcome
  if (text === 'hi' || text === 'hello') {
    await msg.reply(
      `👋 Welcome! I’m a *Sticker Bot*.\n\n` +
      `🟩 Add *crop* to crop square.\n` +
      `🪄 Add *rbg* to remove background (images only).\n\n*` +
      `⚙️ *_Your current credits:_*\n` +
      `• Pack: *${name}*\n` +
      `• Author: *${author}*\n\n` +
      `ℹ️ *_Update with:_*\n` +
      `• Pack name: name *YOURPACK*\n` +
      `• Author name: author *YOURNAME*`
    );
    return;
  }

  // Set pack name
  if (text.startsWith('name ')) {
    const val = raw.slice(5).trim();
    await setPackName(msg, val);
    const cr = getCreditsFor(msg);
    await msg.reply(`✅ Sticker pack name saved: *${cr.name}*`);
    return;
  }

  // Set author
  if (text.startsWith('author ')) {
    const val = raw.slice(7).trim();
    await setAuthor(msg, val);
    const cr = getCreditsFor(msg);
    await msg.reply(`✅ Sticker author saved: *${cr.author}*`);
    return;
  }

  // Media (or reply-to-media)
  if (msg.hasMedia || msg.hasQuotedMsg) {
    await replyWithSticker(msg);
  }

  // Set bot mode
    if (text.startsWith('mode ')) {
    const val = raw.slice(5).trim().toLowerCase();
    const newMode = (val === 'true' || val === 'on');
    
    if (SETTINGS.requireCaption === newMode) {
        await msg.reply(`ℹ️ Mode is already set to *${newMode ? 'Caption must include "sticker"' : 'Auto on any media'}*.`);
        return;
    }

    const updatedSettings = { ...SETTINGS, requireCaption: newMode };
    await saveSettings(updatedSettings);

    await msg.reply(`✅ Bot mode saved: *${newMode ? 'Caption must include "sticker"' : 'Auto on any media'}*`);
    return;
    }

});

// === Express Server for Render ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
  client.initialize();
});