const multer = require('multer');
const Photo = require('../models/Photo');

/*
 * Photos the desk attaches from the portal - usually the handover picture the runner sent on
 * WhatsApp when his app could not. Stored exactly like the phone's own (in MongoDB, never on
 * the container disk, which Render wipes on every deploy), so the same /uploads/:id link
 * opens it.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype || ''))
});

async function storeDeskPhoto(file, meta) {
  if (!file || !file.buffer || !file.buffer.length) return undefined;
  const doc = await Photo.create({
    data: file.buffer,
    contentType: file.mimetype || 'image/jpeg',
    bytes: file.size || file.buffer.length,
    kind: 'PROOF',
    runner: meta.runner || undefined,
    trip: meta.trip || null,
    at: new Date()
  });
  return '/uploads/' + doc._id;
}

module.exports = { upload, storeDeskPhoto };
