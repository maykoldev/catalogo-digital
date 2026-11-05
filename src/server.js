const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/config');

// 0. Validar variables críticas de entorno de Supabase al arrancar
require('./lib/supabaseClient');

const seedDatabase = require('./db/seed');

// Importar rutas
const healthRoutes = require('./routes/healthRoutes');
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const clienteRoutes = require('./routes/clienteRoutes');
const statsRoutes = require('./routes/statsRoutes');
const orderRoutes = require('./routes/orderRoutes');

const app = express();

// Ocultar cabecera X-Powered-By y confiar en cabeceras de proxy cloud (Render, Railway, Cloudflare)
app.disable('x-powered-by');
app.set('trust proxy', 1);

// 1. Inicialización y sembrado de datos multi-inquilino local (si está disponible)
seedDatabase();

// 2. Configuración de CORS para producción y desarrollo local
const allowedOrigins = config.FRONTEND_URL
  ? config.FRONTEND_URL.split(',').map(url => url.trim().replace(/\/$/, '')).filter(Boolean)
  : [];

const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const corsOptions = {
  origin: (origin, callback) => {
    // Permitir peticiones del mismo origen, herramientas CLI, health checks o apps nativas sin cabecera Origin
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.trim().replace(/\/$/, '');

    // Mantener soporte para localhost durante desarrollo y pruebas locales
    if (localhostRegex.test(normalizedOrigin)) {
      return callback(null, true);
    }

    // Si no se definió una lista cerrada en FRONTEND_URL (o es '*'), permitir orígenes dinámicos HTTP/HTTPS de forma segura
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
      if (/^https?:\/\//i.test(normalizedOrigin)) {
        return callback(null, true);
      }
      return callback(new Error('Origen no permitido por política CORS.'));
    }

    // Validar contra orígenes permitidos explícitamente en FRONTEND_URL
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    const corsErr = new Error(`El origen '${origin}' no está autorizado por CORS.`);
    corsErr.status = 403;
    return callback(corsErr);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
  maxAge: 86400
};

app.use(cors(corsOptions));

// 3. Cabeceras de seguridad HTTP y límites de payload (10mb para imágenes/datos)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: config.PAYLOAD_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: config.PAYLOAD_LIMIT }));

// 4. Endpoint de Health Check para monitoreo de producción (/health y /api/health)
app.use('/', healthRoutes);

// Configuración dinámica opcional para el frontend estático
app.get('/js/env-config.js', (req, res) => {
  const publicApiUrl = (process.env.PUBLIC_API_URL || '').trim().replace(/\/$/, '');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`window.APP_CONFIG = { API_BASE_URL: ${JSON.stringify(publicApiUrl)} };\n`);
});

// 5. Servir imágenes de productos y archivos estáticos del frontend
app.use('/productos', express.static(config.PRODUCTOS_DIR, {
  maxAge: '1d',
  fallthrough: false
}));

app.use(express.static(path.join(config.ROOT_DIR, 'public')));

// 6. Rutas de la API RESTful
app.use('/api/auth', authRoutes);
app.use('/api', productRoutes);
app.use('/api', clienteRoutes);
app.use('/api', statsRoutes);
app.use('/api', orderRoutes);

// Respuesta JSON limpia para endpoints /api/* inexistentes
app.use('/api', (req, res) => {
  return res.status(404).json({
    success: false,
    error: `Endpoint no encontrado: ${req.method} ${req.originalUrl}`
  });
});

// 7. Rutas de vistas y Enlaces Únicos de Catálogo
app.get('/c/:slug', (req, res) => {
  res.sendFile(path.join(config.ROOT_DIR, 'public', 'index.html'));
});

app.get('/catalogo/:slug', (req, res) => {
  res.sendFile(path.join(config.ROOT_DIR, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(config.ROOT_DIR, 'public', 'admin.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(config.ROOT_DIR, 'public', 'login.html'));
});

// Manejo centralizado de errores
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: `El tamaño de la petición excede el límite permitido (${config.PAYLOAD_LIMIT}).`
    });
  }
  if (err.status === 403) {
    return res.status(403).json({ success: false, error: err.message });
  }
  if (err.status === 404 || err.code === 'ENOENT') {
    return res.status(404).json({ success: false, error: 'Recurso no encontrado.' });
  }
  console.error('Error no controlado:', err);
  return res.status(500).json({ success: false, error: 'Ocurrió un error interno en el servidor.' });
});

// 8. Inicio del servidor HTTP en 0.0.0.0 y puerto dinámico (Render, Railway, etc.)
const server = app.listen(config.PORT, config.HOST, () => {
  const isProd = config.NODE_ENV === 'production';
  console.log(`====================================================`);
  console.log(`🚀 GENERADOR MULTI-INQUILINO DE CATÁLOGOS DIGITALES`);
  console.log(`🌍 Entorno:            ${config.NODE_ENV}`);
  console.log(`📡 Escuchando en:      http://${config.HOST}:${config.PORT}`);
  console.log(`🩺 Health Check:       http://localhost:${config.PORT}/api/health`);
  console.log(`🔐 Panel Super-Admin:  http://localhost:${config.PORT}/admin`);
  console.log(`🔑 Acceso / Registro:  http://localhost:${config.PORT}/login`);
  if (!isProd) {
    console.log(`🔗 Enlaces Únicos Demo:`);
    console.log(`   - http://localhost:${config.PORT}/c/arte-scrap`);
    console.log(`   - http://localhost:${config.PORT}/c/creaciones-luna`);
  }
  console.log(`====================================================`);
});

// Manejo de cierre limpio para señales locales (SIGINT) y orquestadores cloud (SIGTERM)
const gracefulShutdown = (signal) => {
  console.log(`\nRecibida señal ${signal}. Cerrando servidor HTTP de forma segura...`);
  server.close(() => {
    console.log('Servidor finalizado con éxito.');
    process.exit(0);
  });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = app;
