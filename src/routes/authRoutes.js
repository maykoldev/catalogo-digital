const express = require('express');
const router = express.Router();
const db = require('../db/database');
const AuthService = require('../services/authService');
const authMiddleware = require('../middleware/auth');
const config = require('../config/config');

/**
 * POST /api/auth/login
 * Autenticación de administrador y expedición de token de sesión
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Debe ingresar nombre de usuario y contraseña.'
      });
    }

    const stmt = db.prepare('SELECT * FROM administradores WHERE username = ?');
    const admin = stmt.get(username.trim());

    if (!admin) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales inválidas.'
      });
    }

    const isValid = AuthService.verifyPassword(password, admin.password_hash, admin.salt);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales inválidas.'
      });
    }

    // Generar token criptográfico
    const token = AuthService.generateSessionToken();
    const expiresHours = config.SESSION_DURATION_HOURS || 24;

    const insertSession = db.prepare(`
      INSERT INTO sesiones (token, admin_id, expires_at)
      VALUES (?, ?, datetime('now', 'localtime', '+${expiresHours} hours'))
    `);
    insertSession.run(token, admin.id);

    return res.json({
      success: true,
      message: 'Inicio de sesión exitoso.',
      token,
      user: {
        id: admin.id,
        username: admin.username
      }
    });
  } catch (error) {
    console.error('Error en /api/auth/login:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

/**
 * POST /api/auth/logout
 * Cierre de sesión y revocación inmediata de token
 */
router.post('/logout', authMiddleware, (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM sesiones WHERE token = ?');
    stmt.run(req.admin.token);
    return res.json({ success: true, message: 'Sesión finalizada exitosamente.' });
  } catch (error) {
    console.error('Error en /api/auth/logout:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

/**
 * GET /api/auth/me
 * Valida el token actual y retorna el perfil del administrador
 */
router.get('/me', authMiddleware, (req, res) => {
  return res.json({
    success: true,
    user: req.admin
  });
});

/**
 * POST /api/auth/change-password
 * Permite cambiar la clave de acceso del administrador
 */
router.post('/change-password', authMiddleware, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'La nueva contraseña debe tener al menos 6 caracteres.'
      });
    }

    const admin = db.prepare('SELECT * FROM administradores WHERE id = ?').get(req.admin.id);
    const isValid = AuthService.verifyPassword(currentPassword, admin.password_hash, admin.salt);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña actual no es correcta.'
      });
    }

    const { hash, salt } = AuthService.hashPassword(newPassword);
    db.prepare(`
      UPDATE administradores
      SET password_hash = ?, salt = ?
      WHERE id = ?
    `).run(hash, salt, req.admin.id);

    return res.json({
      success: true,
      message: 'Contraseña actualizada con éxito.'
    });
  } catch (error) {
    console.error('Error en /api/auth/change-password:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

module.exports = router;
