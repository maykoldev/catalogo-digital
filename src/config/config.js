const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '../../');

// Cargar variables de entorno desde .env (compatible con Node >= 18.0.0 y entornos cloud)
dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  FRONTEND_URL: process.env.FRONTEND_URL || '',
  PAYLOAD_LIMIT: process.env.PAYLOAD_LIMIT || '10mb',
  ROOT_DIR,
  PRODUCTOS_DIR: path.join(ROOT_DIR, 'productos'),
  DB_PATH: path.join(ROOT_DIR, 'data', 'catalogo.sqlite'),
  SESSION_DURATION_HOURS: 24,
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  CURRENCY: {
    symbol: '$',
    code: 'USD'
  }
};
