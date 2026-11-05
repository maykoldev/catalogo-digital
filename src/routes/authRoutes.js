const express = require('express');
const router = express.Router();
const AuthService = require('../services/authService');
const authMiddleware = require('../middleware/auth');

/**
 * GET /api/auth/setup-status
 * Indica si el Super-Administrador ya creó su usuario y contraseña iniciales
 */
router.get('/setup-status', async (req, res) => {
  try {
    const status = await AuthService.getSetupStatus();
    return res.json({
      success: true,
      initialized: status.initialized,
      storage: status.storage
    });
  } catch (error) {
    console.error('Error en GET /api/auth/setup-status:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al consultar el estado de configuración.'
    });
  }
});

/**
 * POST /api/auth/setup
 * Registro inicial único del Super-Administrador (se bloquea automáticamente tras crearse)
 */
router.post('/setup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { user, token } = await AuthService.setupSuperAdmin(username, password);

    return res.status(201).json({
      success: true,
      message: 'Cuenta de Super-Administrador creada y guardada con éxito.',
      token,
      user
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error('Error en POST /api/auth/setup:', error);
    }
    return res.status(status).json({
      success: false,
      error: error.message || 'Error interno al crear la cuenta de Super-Administrador.'
    });
  }
});

/**
 * POST /api/auth/login
 * Autenticación de Super-Administrador con sus credenciales personalizadas
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { user, token } = await AuthService.authenticate(username, password);

    return res.json({
      success: true,
      message: 'Inicio de sesión exitoso.',
      token,
      user
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error('Error en POST /api/auth/login:', error);
    }
    return res.status(status).json({
      success: false,
      code: error.code || undefined,
      error: error.message || 'Error interno del servidor.'
    });
  }
});

/**
 * POST /api/auth/logout
 * Cierre de sesión y revocación inmediata de token
 */
router.post('/logout', authMiddleware, (req, res) => {
  try {
    AuthService.revokeSessionToken(req.admin.token);
    return res.json({ success: true, message: 'Sesión finalizada exitosamente.' });
  } catch (error) {
    console.error('Error en POST /api/auth/logout:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

/**
 * GET /api/auth/me
 * Valida el token actual y retorna el perfil del Super-Administrador
 */
router.get('/me', authMiddleware, (req, res) => {
  return res.json({
    success: true,
    user: {
      id: req.admin.id,
      username: req.admin.username
    }
  });
});

/**
 * PUT /api/auth/credentials
 * Permite al Super-Administrador actualizar su usuario y/o contraseña en cualquier momento
 */
router.put('/credentials', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    const { user, token } = await AuthService.updateCredentials(currentPassword, {
      newUsername,
      newPassword
    });

    // Revocar el token anterior y entregar el nuevo
    if (req.admin && req.admin.token) {
      AuthService.revokeSessionToken(req.admin.token);
    }

    return res.json({
      success: true,
      message: 'Tus credenciales de Super-Administrador han sido actualizadas.',
      token,
      user
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error('Error en PUT /api/auth/credentials:', error);
    }
    return res.status(status).json({
      success: false,
      error: error.message || 'Error interno al actualizar credenciales.'
    });
  }
});

/**
 * POST /api/auth/change-password
 * Alias compatible para cambio de contraseña
 */
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const { user, token } = await AuthService.updateCredentials(currentPassword, { newPassword });

    if (req.admin && req.admin.token) {
      AuthService.revokeSessionToken(req.admin.token);
    }

    return res.json({
      success: true,
      message: 'Contraseña actualizada con éxito.',
      token,
      user
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      error: error.message || 'Error interno del servidor.'
    });
  }
});

module.exports = router;
