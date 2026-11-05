const fs = require('fs');
const path = require('path');
const config = require('../config/config');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.warn('ℹ️ [SQLite Local] Módulo nativo node:sqlite no disponible en esta versión de Node. Operando con persistencia en Supabase Cloud.');
}

// Fallback seguro cuando el proveedor cloud ejecuta Node 18/20 sin node:sqlite
if (!DatabaseSync) {
  const noopStmt = {
    get: () => null,
    all: () => [],
    run: () => ({ changes: 0, lastInsertRowid: 0 })
  };
  const fallbackDb = {
    isAvailable: false,
    exec: () => {},
    prepare: () => noopStmt
  };
  module.exports = fallbackDb;
} else {
// Ensure database directory exists
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(config.DB_PATH);
db.isAvailable = true;

// Enable WAL mode and foreign keys for high performance and integrity
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS administradores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    codigo_acceso TEXT UNIQUE NOT NULL,
    descripcion TEXT,
    telefono_whatsapp TEXT,
    email TEXT,
    logo_url TEXT,
    portada_url TEXT,
    color_primario TEXT DEFAULT '#4f46e5',
    moneda_simbolo TEXT DEFAULT '$',
    moneda_codigo TEXT DEFAULT 'USD',
    activo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL DEFAULT 1 REFERENCES clientes(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    precio REAL NOT NULL CHECK(precio >= 0),
    inventario INTEGER NOT NULL DEFAULT 0 CHECK(inventario >= 0),
    categoria TEXT NOT NULL,
    imagen_url TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (admin_id) REFERENCES administradores(id) ON DELETE CASCADE
  );
`);

// Migraciones transparentes para columnas adicionales en clientes
const clientCols = db.prepare('PRAGMA table_info(clientes)').all();
if (!clientCols.some(c => c.name === 'portada_url')) {
  try {
    db.exec('ALTER TABLE clientes ADD COLUMN portada_url TEXT;');
  } catch (e) {
    console.log('Nota migración portada_url:', e.message);
  }
}
if (!clientCols.some(c => c.name === 'logo_url')) {
  try {
    db.exec('ALTER TABLE clientes ADD COLUMN logo_url TEXT;');
  } catch (e) {
    console.log('Nota migración logo_url:', e.message);
  }
}
if (!clientCols.some(c => c.name === 'moneda_simbolo')) {
  try {
    db.exec("ALTER TABLE clientes ADD COLUMN moneda_simbolo TEXT DEFAULT '$';");
  } catch (e) {
    console.log('Nota migración moneda_simbolo:', e.message);
  }
}
if (!clientCols.some(c => c.name === 'moneda_codigo')) {
  try {
    db.exec("ALTER TABLE clientes ADD COLUMN moneda_codigo TEXT DEFAULT 'USD';");
  } catch (e) {
    console.log('Nota migración moneda_codigo:', e.message);
  }
}

// Migración para bases de datos existentes: asegurar columna cliente_id en productos
const productCols = db.prepare('PRAGMA table_info(productos)').all();
const hasClienteId = productCols.some(c => c.name === 'cliente_id');
if (!hasClienteId) {
  try {
    db.exec('ALTER TABLE productos ADD COLUMN cliente_id INTEGER DEFAULT 1;');
  } catch (e) {
    console.log('Nota de migración cliente_id:', e.message);
  }
}

// Índices para optimización de consultas multi-inquilino
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_productos_cliente ON productos(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria);
  CREATE INDEX IF NOT EXISTS idx_clientes_slug ON clientes(slug);
  CREATE INDEX IF NOT EXISTS idx_clientes_codigo ON clientes(codigo_acceso);
  CREATE INDEX IF NOT EXISTS idx_sesiones_token ON sesiones(token);
`);

module.exports = db;
}
