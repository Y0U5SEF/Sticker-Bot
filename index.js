// index.js
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegPath);

// ====== CONFIG ======
const REMOVE_BG_API_KEY = 'mi7WPVJo4x5RReVpvryK3NZX';
const DEFAULT_PACK   = 'My Pack';
const DEFAULT_AUTHOR = 'Sticker Bot';

// ====== PERSISTENCE (per-contact) ======
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'user-settings.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadUserSettingsSync() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}
async function saveUserSettings(settings) {
  try {
    ensureDataDir();
    const tmp = SETTINGS_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
    await fsp.rename(tmp, SETTINGS_PATH);
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}
let USER_SETTINGS = loadUserSettingsSync();

function getUserId(msg) {
  // DM: msg.from ends with @c.us, group: use msg.author if present
  if (msg.from && msg.from.endsWith('@c.us')) return msg.from;
  return msg.author || msg.from;
}
function getCreditsFor(msg) {
  const id = getUserId(msg);
  const rec = USER_SETTINGS[id] || {};
  return {
    name: rec.name || DEFAULT_PACK,
    author: rec.author || DEFAULT_AUTHOR,
  };
}
async function setPackName(msg, value) {
  const id = getUserId(msg);
  USER_SETTINGS[id] = USER_SETTINGS[id] || {};
  USER_SETTINGS[id].name = value || DEFAULT_PACK;
  await saveUserSettings(USER_SETTINGS);
}
async function setAuthor(msg, value) {
  const id = getUserId(msg);
  USER_SETTINGS[id] = USER_SETTINGS[id] || {};
  USER_SETTINGS[id].author = value || DEFAULT_AUTHOR;
  await saveUserSettings(USER_SETTINGS);
}

// ====== CAPTION FLAGS ======
const wantsSquare = (t = '') => {
  const s = t.toLowerCase();
  return s.includes('square') || s.includes('sqaure') || s.includes('1:1'); // tolerate typo
};
const wantsRbg = (t = '') => t.toLowerCase().split(/\s+/).includes('rbg'); // exact keyword

// ====== MEDIA FETCH (robust) ======
async function fetchMedia(msg) {
  try { const m1 = await msg.downloadMedia(); if (m1) return m1; } catch {}
  await new Promise(r => setTimeout(r, 700));
  try { const m2 = await msg.downloadMedia(); if (m2) return m2; } catch {}
  try {
    if (msg.hasQuotedMsg) {
      const q = await msg.getQuotedMessage();
      if (q && q.hasMedia) {
        const m3 = await q.downloadMedia();
        if (m3) return m3;
      }
    }
  } catch {}
  return null;
}

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
    .png()
    .toBuffer();

  return new MessageMedia('image/png', outBuf.toString('base64'), 'square.png');
}

// ====== VIDEO/GIF PROCESSOR (temp file path) ======
async function cropVideoToSquareFile(messageMedia /* MessageMedia */, { maxDur = 8, size = 512, fps = 15 } = {}) {
  const inFile = path.join(os.tmpdir(), `in_${Date.now()}.mp4`);
  const outFile = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);
  await fsp.writeFile(inFile, Buffer.from(messageMedia.data, 'base64'));

  const vf = [
    "crop='min(iw,ih)':'min(iw,ih)'",
    `scale=${size}:${size}:flags=lanczos`,
    `fps=${fps}`
  ].join(',');

  await new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .noAudio()
      .videoCodec('libx264')
      .outputOptions(['-preset veryfast', `-t ${maxDur}`, '-movflags +faststart', '-pix_fmt yuv420p'])
      .videoFilters(vf)
      .on('error', reject)
      .on('end', resolve)
      .save(outFile);
  });

  try { await fsp.unlink(inFile); } catch {}
  return outFile;
}

// ====== CLIENT ======
let client; // forward-declared for helpers below
client = new Client({
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
  const media = await fetchMedia(msg);
  if (!media) {
    await msg.reply('⚠️ Could not download media. Send the media and the caption (e.g., "square" / "rbg") in the *same* message or reply directly to the media.');
    return;
  }

  const caption = msg.body || '';
  const doSquare = wantsSquare(caption);
  const doRbg    = wantsRbg(caption);

  const isImage = media.mimetype?.startsWith('image/');
  const isGif   = media.mimetype === 'image/gif';
  const isVideo = media.mimetype?.startsWith('video/');

  try {
    // --- Static images ---
    if (isImage && !isGif) {
      let work = media;

      if (doRbg) {
        work = await removeBgFromImage(work);
      }
      if (doSquare) {
        work = await cropImageToSquare(work);
      }

      const mm = new MessageMedia(work.mimetype, work.data, work.filename || 'sticker.png');
      await sendSticker(msg, mm);

    //   if (doRbg && doSquare) await msg.reply('🪄 Background removed and cropped to 1:1.');
    //   else if (doRbg)        await msg.reply('🪄 Background removed.');
    //   else if (doSquare)     await msg.reply('🟩 Cropped to 1:1.');
      return;
    }

    // --- GIF/Video ---
    if (isGif || isVideo) {
      if (doSquare) {
        const outPath = await cropVideoToSquareFile(media, { maxDur: 8, size: 512, fps: 15 });
        await sendSticker(msg, outPath);
        await msg.reply('🟩 Cropped video/GIF to 1:1.');
        try { await fsp.unlink(outPath); } catch {}
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
client.on('ready', () => console.log('✅ Bot is ready!'));

client.on('message', async (msg) => {
  const raw  = msg.body || '';
  const text = raw.trim().toLowerCase();
  const { name, author } = getCreditsFor(msg);

  // Welcome
  if (text === 'hi' || text === 'hello') {
    await msg.reply(
      `👋 Welcome! I’m a *Sticker Bot*.\n\n` +
      `📌 Send an *image* or short *video/GIF* and I’ll make it a sticker.\n` +
      `🟩 Add *square* (or *1:1*) in the caption to crop square.\n` +
      `🪄 Add *rbg* in the caption to remove background (images only).\n\n` +
      `⚙️ Your current credits:\n` +
      `• Pack: *${name}*\n` +
      `• Author: *${author}*\n\n` +
      `Update with:\n` +
      `• Pack name: *name YOURPACK*\n` +
      `• Author name: *author YOURNAME*`
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

  // Media
  if (msg.hasMedia || msg.hasQuotedMsg) {
    await replyWithSticker(msg);
  }
});

client.initialize();
