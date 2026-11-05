const db = require('../db/database');

function authMiddleware(req, res, next) {
  // Obtener token desde Header Authorization, x-access-token o query param
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

  // Verificar validez y expiración del token en la base de datos
  const stmt = db.prepare(`
    SELECT s.token, s.expires_at, a.id as admin_id, a.username
    FROM sesiones s
    JOIN administradores a ON s.admin_id = a.id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now', 'localtime')
  `);

  const session = stmt.get(token);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Sesión expirada o token inválido. Por favor ingrese sus credenciales nuevamente.'
    });
  }

  req.admin = {
    id: session.admin_id,
    username: session.username,
    token: session.token
  };

  next();
}

module.exports = authMiddleware;
