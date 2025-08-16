// index.js
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegPath);

// --- settings ---
let stickerPackName = 'My Pack';
let stickerAuthor   = 'Sticker Bot';
const REMOVE_BG_API_KEY = 'mi7WPVJo4x5RReVpvryK3NZX';

// --- helpers for caption flags ---
const wantsSquare = (t='') => t.toLowerCase().includes('square') || t.toLowerCase().includes('1:1');
const wantsRbg    = (t='') => t.toLowerCase().split(/\s+/).includes('rbg'); // exact keyword in caption

// --- image processors ---
async function removeBgFromImage(media /* MessageMedia */) {
  const inputB64 = media.data; // clean base64, no data URI
  const res = await axios.post(
    'https://api.remove.bg/v1.0/removebg',
    { image_file_b64: inputB64, size: 'auto' },
    { headers: { 'X-Api-Key': REMOVE_BG_API_KEY }, responseType: 'arraybuffer' }
  );
  if (res.status !== 200) throw new Error(`remove.bg failed: ${res.status} ${res.statusText}`);

  const outB64 = Buffer.from(res.data).toString('base64'); // ensure no 'binary' encoding issues
  return new MessageMedia('image/png', outB64, 'nobg.png');
}

async function cropImageToSquare(media /* MessageMedia */) {
  const buf = Buffer.from(media.data, 'base64');
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

// --- video/gif processor (writes temp file and returns file path) ---
async function cropVideoToSquareFile(media /* MessageMedia */, { maxDur = 8, size = 512, fps = 15 } = {}) {
  const inFile  = path.join(os.tmpdir(), `in_${Date.now()}.mp4`);
  const outFile = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);
  await fs.writeFile(inFile, Buffer.from(media.data, 'base64'));

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

  // cleanup input after processing to keep temp small
  try { await fs.unlink(inFile); } catch {}

  return outFile; // we’ll pass a file path to sendMessage
}

// --- send sticker (accepts MessageMedia OR file path) ---
async function sendSticker(from, payload /* MessageMedia|string(path) */) {
  await globalClient.sendMessage(from, payload, {
    sendMediaAsSticker: true,
    stickerName: stickerPackName,
    stickerAuthor: stickerAuthor,
  });
}

// --- main sticker flow ---
async function replyWithSticker(msg) {
  const media = await msg.downloadMedia(); // returns MessageMedia with .data base64
  if (!media) { await msg.reply('⚠️ Could not download media.'); return; }

  const caption = msg.body || '';
  const square  = wantsSquare(caption);
  const rbg     = wantsRbg(caption);

  const isImage = media.mimetype?.startsWith('image/');
  const isGif   = media.mimetype === 'image/gif';
  const isVideo = media.mimetype?.startsWith('video/');

  try {
    // ----- Static images path -----
    if (isImage && !isGif) {
      let work = media;

      // run remove.bg only if caption explicitly has "rbg"
      if (rbg) {
        work = await removeBgFromImage(work);
      }

      if (square) {
        work = await cropImageToSquare(work);
      }

      // Always send as a fresh MessageMedia (ensures clean base64 & mimetype)
      const mm = new MessageMedia(work.mimetype, work.data, work.filename || 'sticker.png');
      await sendSticker(msg.from, mm);
      if (rbg && square) await msg.reply('🪄 Background removed and cropped to 1:1.');
      else if (rbg)      await msg.reply('🪄 Background removed.');
      else if (square)   await msg.reply('🟩 Cropped to 1:1.');
      return;
    }

    // ----- Animated (gif/video) path -----
    if (isGif || isVideo) {
      if (square) {
        const outPath = await cropVideoToSquareFile(media, { maxDur: 8, size: 512, fps: 15 });
        await sendSticker(msg.from, outPath);
        await msg.reply('🟩 Cropped video/GIF to 1:1.');
        try { await fs.unlink(outPath); } catch {}
        return;
      }

      // No special handling -> let library do its thing
      await sendSticker(msg.from, media);
      return;
    }

    // Fallback: send as-is
    await sendSticker(msg.from, media);
  } catch (e) {
    console.error('Sticker processing failed:', e);
    await msg.reply('⚠️ Processing failed. Sending original as sticker.');
    await sendSticker(msg.from, media);
  }
}

// --- bot wiring ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wweb-auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  ffmpegPath: ffmpegPath || undefined,
});
global.globalClient = client;

client.on('qr', qr => { console.clear(); qrcode.generate(qr, { small: true }); });
client.on('ready', () => console.log('✅ Bot is ready!'));

client.on('message', async (msg) => {
  const raw  = msg.body || '';
  const text = raw.trim().toLowerCase();

  // welcome
  if (text === 'hi' || text === 'hello') {
    await msg.reply(
      `👋 Welcome! I’m a *Sticker Bot*.\n\n` +
      `📌 Send an *image* or short *video/GIF* and I’ll make it a sticker.\n` +
      `🟩 Add *square* (or *1:1*) in the caption to crop square.\n` +
      `🪄 Add *rbg* in the caption to remove background (images only).\n\n` +
      `⚙️ Settings:\n` +
      `• Pack name: *name YOURPACK*\n` +
      `• Author name: *author YOURNAME*`
    );
    return;
  }

  // set pack/author
  if (text.startsWith('name ')) {
    stickerPackName = raw.slice(5).trim();
    await msg.reply(`✅ Sticker pack name set to: *${stickerPackName}*`);
    return;
  }
  if (text.startsWith('author ')) {
    stickerAuthor = raw.slice(7).trim();
    await msg.reply(`✅ Sticker author set to: *${stickerAuthor}*`);
    return;
  }

  // media handler
  if (msg.hasMedia) {
    await replyWithSticker(msg);
  }
});

client.initialize();
