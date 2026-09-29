const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const ImageKit = require('imagekit');
const multer = require('multer');

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || '',
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || '',
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || '',
});

// Get ImageKit auth params (for client-side upload)
router.get('/auth', protect, (req, res) => {
  try {
    const result = imagekit.getAuthenticationParameters();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Server-side upload using multer with robust fallback
router.post('/image', protect, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Attempt ImageKit upload if keys exist
    if (process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY) {
      try {
        const response = await imagekit.upload({
          file: req.file.buffer,
          fileName: req.file.originalname,
          folder: '/crm-tracker',
          useUniqueFileName: true,
        });
        if (response && response.url) {
          return res.json({
            success: true,
            url: response.url,
            fileId: response.fileId,
            thumbnailUrl: response.thumbnailUrl,
          });
        }
      } catch (ikErr) {
        console.warn('ImageKit upload warning, using base64 fallback:', ikErr.message);
      }
    }

    // Fallback: Base64 data URL
    const mime = req.file.mimetype || 'image/png';
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    res.json({ success: true, url: dataUrl });
  } catch (err) {
    console.error('Upload route error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
