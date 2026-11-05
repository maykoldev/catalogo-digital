const fs = require('fs');
const path = require('path');
const db = require('./database');
const config = require('../config/config');
const AuthService = require('../services/authService');

function seedDatabase() {
  if (!db || db.isAvailable === false) {
    return;
  }
  console.log('--- Verificando Inicialización Multi-Inquilino ---');

  // 1. Asegurar Administrador por defecto
  const checkAdminStmt = db.prepare('SELECT id FROM administradores WHERE username = ?');
  const existingAdmin = checkAdminStmt.get(config.ADMIN_DEFAULT.username);

  if (!existingAdmin) {
    const { hash, salt } = AuthService.hashPassword(config.ADMIN_DEFAULT.password);
    db.prepare(`
      INSERT INTO administradores (username, password_hash, salt)
      VALUES (?, ?, ?)
    `).run(config.ADMIN_DEFAULT.username, hash, salt);
    console.log(`[Seguridad] Administrador creado: '${config.ADMIN_DEFAULT.username}'`);
  }

  // 2. Asegurar Clientes Iniciales con Logo y Portada
  const clientCount = db.prepare('SELECT COUNT(*) as count FROM clientes').get().count;

  let cliente1Id = 1;
  let cliente2Id = 2;

  const defaultArteScrapCover = `/productos/${encodeURIComponent('WhatsApp Image 2026-11-04 at 7.09.24 PM (4).jpeg')}`;
  const defaultArteScrapLogo = `/productos/${encodeURIComponent('WhatsApp Image 2026-11-04 at 7.09.24 PM (5).jpeg')}`;

  const defaultLunaCover = `/productos/${encodeURIComponent('WhatsApp Image 2026-11-04 at 7.09.22 PM (1).jpeg')}`;
  const defaultLunaLogo = `/productos/${encodeURIComponent('WhatsApp Image 2026-11-04 at 7.09.25 PM (2).jpeg')}`;

  if (clientCount === 0) {
    console.log('[Multi-Inquilino] Creando clientes iniciales con logos y portadas...');

    const insertClient = db.prepare(`
      INSERT INTO clientes (nombre, slug, codigo_acceso, descripcion, telefono_whatsapp, email, logo_url, portada_url, color_primario, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const c1 = insertClient.run(
      'Arte & Scrap Express',
      'arte-scrap',
      'artescrap2026',
      'Catálogo mayorista y detal de suministros para manualidades, papelería especial y scrapbooking.',
      '+584121112233',
      'contacto@artescrap.com',
      defaultArteScrapLogo,
      defaultArteScrapCover,
      '#4f46e5'
    );
    cliente1Id = c1.lastInsertRowid;

    const c2 = insertClient.run(
      'Creaciones Luna & Empaques',
      'creaciones-luna',
      'luna7788',
      'Cintas decorativas de satín, washi tapes de regalo y empaques artesanales para celebraciones.',
      '+584149998877',
      'pedidos@creacionesluna.com',
      defaultLunaLogo,
      defaultLunaCover,
      '#ec4899'
    );
    cliente2Id = c2.lastInsertRowid;
  } else {
    // Si ya existen, asegurar que tengan portada y logo si están vacíos
    db.prepare(`
      UPDATE clientes
      SET portada_url = ?, logo_url = ?
      WHERE slug = 'arte-scrap' AND (portada_url IS NULL OR portada_url = '')
    `).run(defaultArteScrapCover, defaultArteScrapLogo);

    db.prepare(`
      UPDATE clientes
      SET portada_url = ?, logo_url = ?
      WHERE slug = 'creaciones-luna' AND (portada_url IS NULL OR portada_url = '')
    `).run(defaultLunaCover, defaultLunaLogo);
  }
}

if (require.main === module) {
  seedDatabase();
}

module.exports = seedDatabase;
