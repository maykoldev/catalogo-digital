const crypto = require('crypto');
const config = require('../config/config');
const db = require('../db/database');
const { supabaseAdmin, createClient } = require('../lib/supabaseClient');

class AuthService {
  static revokedTokens = new Map();
  static _setupInProgress = false;

  /**
   * Genera hash PBKDF2 con SHA-512 y salt aleatorio
   */
  static hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }

  /**
   * Verifica de forma segura en tiempo constante si la contraseña coincide con el hash almacenado
   */
  static verifyPassword(password, storedHash, salt) {
    if (!password || !storedHash || !salt) return false;
    const { hash } = this.hashPassword(password, salt);
    const hashBuf = Buffer.from(hash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (hashBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, storedBuf);
  }

  /**
   * Clave derivada HMAC para firmar tokens de sesión persistentes entre reinicios
   */
  static _getSigningKey() {
    const rawSecret =
      config.SESSION_SECRET ||
      process.env.SESSION_SECRET ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      'catalogo-digital-local-fallback-secret';
    return crypto.createHash('sha256').update(`${rawSecret}::catalogo-superadmin-v1`).digest();
  }

  /**
   * Limpia tokens revocados cuya fecha de expiración ya pasó
   */
  static _cleanupRevokedTokens() {
    const now = Date.now();
    for (const [key, exp] of this.revokedTokens.entries()) {
      if (exp <= now) {
        this.revokedTokens.delete(key);
      }
    }
  }

  /**
   * Genera un token de sesión firmado criptográficamente (HMAC-SHA256)
   */
  static createSessionToken(admin, expiresHours = config.SESSION_DURATION_HOURS || 24) {
    const now = Date.now();
    const payload = {
      sub: String(admin.id),
      username: String(admin.username),
      role: 'superadmin',
      iat: now,
      exp: now + expiresHours * 3600 * 1000,
      jti: crypto.randomBytes(12).toString('hex')
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const unsigned = `sa1.${payloadB64}`;
    const signature = crypto
      .createHmac('sha256', this._getSigningKey())
      .update(unsigned)
      .digest('base64url');

    return `${unsigned}.${signature}`;
  }

  /**
   * Verifica la firma, vigencia y estado de revocación de un token de sesión
   */
  static verifySessionToken(token) {
    if (!token || typeof token !== 'string' || !token.startsWith('sa1.')) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [prefix, payloadB64, providedSig] = parts;
    const unsigned = `${prefix}.${payloadB64}`;
    const expectedSig = crypto
      .createHmac('sha256', this._getSigningKey())
      .update(unsigned)
      .digest('base64url');

    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (!payload || payload.role !== 'superadmin' || !payload.exp || payload.exp <= Date.now()) {
        return null;
      }

      this._cleanupRevokedTokens();
      if (this.revokedTokens.has(payload.jti) || this.revokedTokens.has(token)) {
        return null;
      }

      return {
        id: payload.sub,
        username: payload.username,
        jti: payload.jti,
        exp: payload.exp,
        token
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Revoca inmediatamente un token activo
   */
  static revokeSessionToken(token) {
    if (!token) return;
    const verified = this.verifySessionToken(token);
    if (verified) {
      this.revokedTokens.set(verified.jti, verified.exp);
      this.revokedTokens.set(token, verified.exp);
    }
    if (db && db.isAvailable) {
      try {
        db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
      } catch (_) {}
    }
  }

  /**
   * Convierte cualquier nombre de usuario personalizado en un email interno determinista válido para Supabase Auth
   */
  static usernameToInternalEmail(username) {
    const cleanLower = String(username || '').trim().toLowerCase();
    const digest = crypto.createHash('sha256').update(cleanLower, 'utf8').digest('hex').slice(0, 24);
    return `sa_${digest}@catalogo-superadmin.com`;
  }

  /**
   * Valida formato de usuario y contraseña
   */
  static validateCredentialsInput(username, password, { checkUsername = true, checkPassword = true } = {}) {
    if (checkUsername) {
      const cleanUser = String(username || '').trim();
      if (cleanUser.length < 3 || cleanUser.length > 50) {
        const err = new Error('El nombre de usuario debe tener entre 3 y 50 caracteres.');
        err.status = 400;
        throw err;
      }
      if (/\s/.test(cleanUser)) {
        const err = new Error('El nombre de usuario no debe contener espacios.');
        err.status = 400;
        throw err;
      }
    }

    if (checkPassword) {
      if (!password || typeof password !== 'string' || password.length < 6 || password.length > 128) {
        const err = new Error('La contraseña debe tener al menos 6 caracteres.');
        err.status = 400;
        throw err;
      }
    }
  }

  /**
   * Sincroniza la cuenta del Super-Admin en SQLite local (si está disponible) como respaldo
   */
  static _syncLocalAdmin(username, hash, salt) {
    if (!db || !db.isAvailable) return null;
    try {
      db.prepare('DELETE FROM sesiones').run();
      db.prepare('DELETE FROM administradores').run();
      const res = db
        .prepare('INSERT INTO administradores (username, password_hash, salt) VALUES (?, ?, ?)')
        .run(username, hash, salt);
      return res.lastInsertRowid;
    } catch (_) {
      return null;
    }
  }

  /**
   * Busca la cuenta única de Super-Administrador en Supabase Auth
   */
  static async _findSupabaseSuperAdmin() {
    if (!supabaseAdmin || !supabaseAdmin.auth || !supabaseAdmin.auth.admin) {
      return { available: false, user: null };
    }

    try {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 });
      if (error) {
        console.error('[AuthService] Error consultando Supabase Auth:', error.message);
        return { available: false, user: null, error };
      }

      const users = (data && data.users) || [];
      const superAdmin = users.find(
        (u) =>
          (u.app_metadata && u.app_metadata.role === 'superadmin') ||
          (u.user_metadata && u.user_metadata.role === 'superadmin')
      );

      return { available: true, user: superAdmin || null };
    } catch (err) {
      console.error('[AuthService] Excepción consultando Supabase Auth:', err.message);
      return { available: false, user: null, error: err };
    }
  }

  /**
   * Verifica si ya existe un Super-Administrador configurado
   */
  static async getSetupStatus() {
    const supa = await this._findSupabaseSuperAdmin();
    if (supa.available) {
      return {
        initialized: Boolean(supa.user),
        storage: 'supabase'
      };
    }

    if (db && db.isAvailable) {
      const row = db.prepare('SELECT id FROM administradores LIMIT 1').get();
      return {
        initialized: Boolean(row),
        storage: 'local'
      };
    }

    return { initialized: false, storage: 'none' };
  }

  /**
   * Crea por única vez la cuenta personalizada del Super-Administrador
   */
  static async setupSuperAdmin(username, password) {
    if (this._setupInProgress) {
      const err = new Error('Configuración en curso. Intente nuevamente en unos segundos.');
      err.status = 409;
      throw err;
    }

    this._setupInProgress = true;
    try {
      const cleanUsername = String(username || '').trim();
      this.validateCredentialsInput(cleanUsername, password);

      const { hash, salt } = this.hashPassword(password);
      const supa = await this._findSupabaseSuperAdmin();

      if (supa.available) {
        if (supa.user) {
          const err = new Error('El Super-Administrador ya fue configurado previamente. Inicie sesión con su usuario y contraseña.');
          err.status = 403;
          throw err;
        }

        const internalEmail = this.usernameToInternalEmail(cleanUsername);
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email: internalEmail,
          password,
          email_confirm: true,
          user_metadata: {
            username: cleanUsername,
            role: 'superadmin'
          },
          app_metadata: {
            role: 'superadmin',
            username: cleanUsername,
            username_lower: cleanUsername.toLowerCase(),
            pwd_hash: hash,
            pwd_salt: salt
          }
        });

        if (error || !data || !data.user) {
          const err = new Error((error && error.message) || 'No se pudo registrar el Super-Administrador en Supabase.');
          err.status = 500;
          throw err;
        }

        this._syncLocalAdmin(cleanUsername, hash, salt);

        const userObj = { id: data.user.id, username: cleanUsername };
        const token = this.createSessionToken(userObj);
        return { user: userObj, token };
      }

      // Respaldo local si Supabase no está accesible temporalmente
      if (db && db.isAvailable) {
        const existing = db.prepare('SELECT id FROM administradores LIMIT 1').get();
        if (existing) {
          const err = new Error('El Super-Administrador ya fue configurado previamente. Inicie sesión con sus credenciales.');
          err.status = 403;
          throw err;
        }

        const localId = this._syncLocalAdmin(cleanUsername, hash, salt) || 1;
        const userObj = { id: String(localId), username: cleanUsername };
        const token = this.createSessionToken(userObj);
        return { user: userObj, token };
      }

      const err = new Error('No hay conexión disponible con el servicio de almacenamiento para guardar las credenciales.');
      err.status = 503;
      throw err;
    } finally {
      this._setupInProgress = false;
    }
  }

  /**
   * Verifica la contraseña de un usuario de Supabase usando su hash PBKDF2 o GoTrue como respaldo
   */
  static async _verifySupabaseUserPassword(supaUser, password) {
    const meta = supaUser.app_metadata || {};
    if (meta.pwd_hash && meta.pwd_salt) {
      if (this.verifyPassword(password, meta.pwd_hash, meta.pwd_salt)) {
        return true;
      }
    }

    // Respaldo por si la contraseña se actualizó manualmente desde el panel de Supabase
    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
    if (supabaseUrl && supabaseAnonKey && supaUser.email) {
      try {
        const tempClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data, error } = await tempClient.auth.signInWithPassword({
          email: supaUser.email,
          password
        });
        if (!error && data && data.user) {
          return true;
        }
      } catch (_) {}
    }

    return false;
  }

  /**
   * Autentica al Super-Administrador y emite un token de sesión firmado
   */
  static async authenticate(username, password) {
    const cleanUsername = String(username || '').trim();
    if (!cleanUsername || !password) {
      const err = new Error('Debe ingresar su nombre de usuario y contraseña.');
      err.status = 400;
      throw err;
    }

    const supa = await this._findSupabaseSuperAdmin();
    if (supa.available) {
      if (!supa.user) {
        const err = new Error('Aún no se ha creado la cuenta de Super-Administrador. Configúrela primero.');
        err.status = 403;
        err.code = 'SETUP_REQUIRED';
        throw err;
      }

      const storedUsername =
        (supa.user.app_metadata && supa.user.app_metadata.username) ||
        (supa.user.user_metadata && supa.user.user_metadata.username) ||
        '';

      if (storedUsername.toLowerCase() !== cleanUsername.toLowerCase()) {
        const err = new Error('Usuario o contraseña incorrectos.');
        err.status = 401;
        throw err;
      }

      const validPwd = await this._verifySupabaseUserPassword(supa.user, password);
      if (!validPwd) {
        const err = new Error('Usuario o contraseña incorrectos.');
        err.status = 401;
        throw err;
      }

      const userObj = { id: supa.user.id, username: storedUsername };
      const token = this.createSessionToken(userObj);
      return { user: userObj, token };
    }

    // Respaldo en SQLite local
    if (db && db.isAvailable) {
      const totalAdmins = db.prepare('SELECT COUNT(*) as count FROM administradores').get();
      if (!totalAdmins || totalAdmins.count === 0) {
        const err = new Error('Aún no se ha creado la cuenta de Super-Administrador. Configúrela primero.');
        err.status = 403;
        err.code = 'SETUP_REQUIRED';
        throw err;
      }

      const admin = db
        .prepare('SELECT * FROM administradores WHERE LOWER(username) = LOWER(?)')
        .get(cleanUsername);

      if (!admin || !this.verifyPassword(password, admin.password_hash, admin.salt)) {
        const err = new Error('Usuario o contraseña incorrectos.');
        err.status = 401;
        throw err;
      }

      const userObj = { id: String(admin.id), username: admin.username };
      const token = this.createSessionToken(userObj);
      return { user: userObj, token };
    }

    const err = new Error('Servicio de autenticación no disponible.');
    err.status = 503;
    throw err;
  }

  /**
   * Permite al Super-Administrador autenticado cambiar su nombre de usuario y/o contraseña
   */
  static async updateCredentials(currentPassword, { newUsername, newPassword } = {}) {
    if (!currentPassword) {
      const err = new Error('Debe ingresar su contraseña actual para confirmar los cambios.');
      err.status = 400;
      throw err;
    }

    const hasNewUsername = typeof newUsername === 'string' && newUsername.trim().length > 0;
    const hasNewPassword = typeof newPassword === 'string' && newPassword.length > 0;

    if (!hasNewUsername && !hasNewPassword) {
      const err = new Error('Indique un nuevo nombre de usuario o una nueva contraseña.');
      err.status = 400;
      throw err;
    }

    this.validateCredentialsInput(newUsername, newPassword, {
      checkUsername: hasNewUsername,
      checkPassword: hasNewPassword
    });

    const supa = await this._findSupabaseSuperAdmin();
    if (supa.available && supa.user) {
      const validCurrent = await this._verifySupabaseUserPassword(supa.user, currentPassword);
      if (!validCurrent) {
        const err = new Error('La contraseña actual no es correcta.');
        err.status = 400;
        throw err;
      }

      const currentUsername =
        (supa.user.app_metadata && supa.user.app_metadata.username) ||
        (supa.user.user_metadata && supa.user.user_metadata.username) ||
        'superadmin';

      const finalUsername = hasNewUsername ? newUsername.trim() : currentUsername;
      const passwordToHash = hasNewPassword ? newPassword : currentPassword;
      const { hash, salt } = this.hashPassword(passwordToHash);

      const updatePayload = {
        email: this.usernameToInternalEmail(finalUsername),
        email_confirm: true,
        user_metadata: {
          username: finalUsername,
          role: 'superadmin'
        },
        app_metadata: {
          role: 'superadmin',
          username: finalUsername,
          username_lower: finalUsername.toLowerCase(),
          pwd_hash: hash,
          pwd_salt: salt
        }
      };

      if (hasNewPassword) {
        updatePayload.password = newPassword;
      }

      const { data, error } = await supabaseAdmin.auth.admin.updateUserById(supa.user.id, updatePayload);
      if (error || !data || !data.user) {
        const err = new Error((error && error.message) || 'Error al actualizar credenciales en Supabase.');
        err.status = 500;
        throw err;
      }

      this._syncLocalAdmin(finalUsername, hash, salt);

      const userObj = { id: data.user.id, username: finalUsername };
      const token = this.createSessionToken(userObj);
      return { user: userObj, token };
    }

    if (db && db.isAvailable) {
      const admin = db.prepare('SELECT * FROM administradores LIMIT 1').get();
      if (!admin || !this.verifyPassword(currentPassword, admin.password_hash, admin.salt)) {
        const err = new Error('La contraseña actual no es correcta.');
        err.status = 400;
        throw err;
      }

      const finalUsername = hasNewUsername ? newUsername.trim() : admin.username;
      const passwordToHash = hasNewPassword ? newPassword : currentPassword;
      const { hash, salt } = this.hashPassword(passwordToHash);

      this._syncLocalAdmin(finalUsername, hash, salt);
      const updated = db.prepare('SELECT id, username FROM administradores LIMIT 1').get();
      const userObj = { id: String(updated.id), username: updated.username };
      const token = this.createSessionToken(userObj);
      return { user: userObj, token };
    }

    const err = new Error('No se pudieron actualizar las credenciales.');
    err.status = 503;
    throw err;
  }
}

module.exports = AuthService;
