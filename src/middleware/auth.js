const db = require('../db/database');
const AuthService = require('../services/authService');

function authMiddleware(req, res, next) {
  // Obtener token desde Header Authorization, x-admin-token o query param
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Acceso no autorizado. Debe iniciar sesión en el panel de control.'
    });
  }

  // 1. Validar token criptográfico firmado (compatible con despliegues cloud sin estado local)
  const verified = AuthService.verifySessionToken(token);
  if (verified) {
    req.admin = {
      id: verified.id,
      username: verified.username,
      token: verified.token
    };
    return next();
  }

  // 2. Respaldo para sesiones SQLite heredadas si la BD local está disponible
  if (db && db.isAvailable) {
    const stmt = db.prepare(`
      SELECT s.token, s.expires_at, a.id as admin_id, a.username
      FROM sesiones s
      JOIN administradores a ON s.admin_id = a.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now', 'localtime')
    `);

    const session = stmt.get(token);
    if (session) {
      req.admin = {
        id: session.admin_id,
        username: session.username,
        token: session.token
      };
      return next();
    }
  }

  return res.status(401).json({
    success: false,
    error: 'Sesión expirada o token inválido. Por favor ingrese sus credenciales nuevamente.'
  });
}

module.exports = authMiddleware;
