const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

// Asegurar que la carpeta 'productos' exista
if (!fs.existsSync(config.PRODUCTOS_DIR)) {
  fs.mkdirSync(config.PRODUCTOS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.PRODUCTOS_DIR);
  },
  filename: function (req, file, cb) {
    // Sanitizar nombre de archivo y agregar timestamp para evitar colisiones
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 30);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
    cb(null, `${baseName}_${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Formato de imagen no válido. Solo se admiten JPG, PNG, WEBP y GIF.'));
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // Máximo 5MB
  },
  fileFilter
});

module.exports = upload;
