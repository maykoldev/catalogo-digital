const db = require('../db/database');
const crypto = require('crypto');

class ClienteService {
  /**
   * Genera un slug URL-friendly a partir de un texto
   */
  static generateSlug(text) {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  /**
   * Obtiene todos los clientes con métricas agregadas de sus respectivos catálogos
   */
  static getAll({ search } = {}) {
    let query = `
      SELECT 
        c.*,
        COUNT(p.id) as total_productos,
        COALESCE(SUM(p.inventario), 0) as total_unidades,
        COALESCE(SUM(p.precio * p.inventario), 0) as valor_inventario
      FROM clientes c
      LEFT JOIN productos p ON c.id = p.cliente_id
      WHERE 1=1
    `;
    const params = [];

    if (search && search.trim() !== '') {
      query += ` AND (c.nombre LIKE ? OR c.slug LIKE ? OR c.email LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    query += ` GROUP BY c.id ORDER BY c.created_at DESC`;

    const stmt = db.prepare(query);
    const rows = stmt.all(...params);

    return rows.map(r => ({
      ...r,
      moneda_simbolo: r.moneda_simbolo || '$',
      moneda_codigo: r.moneda_codigo || 'USD',
      valor_inventario: Number(Number(r.valor_inventario).toFixed(2)),
      enlace_publico: `/c/${r.slug}`
    }));
  }

  /**
   * Obtiene un cliente por su ID numérico
   */
  static getById(id) {
    const stmt = db.prepare('SELECT * FROM clientes WHERE id = ?');
    const client = stmt.get(Number(id));
    if (!client) return null;
    return {
      ...client,
      moneda_simbolo: client.moneda_simbolo || '$',
      moneda_codigo: client.moneda_codigo || 'USD',
      enlace_publico: `/c/${client.slug}`
    };
  }

  /**
   * Busca un cliente por su slug o por su código de acceso único
   */
  static getBySlugOrCode(identifier) {
    if (!identifier) return null;
    const clean = identifier.trim().toLowerCase();
    const stmt = db.prepare(`
      SELECT * FROM clientes 
      WHERE (LOWER(slug) = ? OR LOWER(codigo_acceso) = ?) AND activo = 1
    `);
    const client = stmt.get(clean, clean);
    if (!client) return null;
    return {
      ...client,
      moneda_simbolo: client.moneda_simbolo || '$',
      moneda_codigo: client.moneda_codigo || 'USD',
      enlace_publico: `/c/${client.slug}`
    };
  }

  /**
   * Registra un nuevo cliente con moneda personalizada, logo y portada
   */
  static create({ nombre, slug, descripcion, telefono_whatsapp, email, logo_url, portada_url, color_primario, moneda_simbolo, moneda_codigo }) {
    if (!nombre || nombre.trim() === '') {
      throw new Error('El nombre del cliente o empresa es obligatorio.');
    }

    let finalSlug = slug ? this.generateSlug(slug) : this.generateSlug(nombre);
    if (!finalSlug) finalSlug = `cat-${Date.now()}`;

    // Verificar unicidad de slug
    const checkSlug = db.prepare('SELECT id FROM clientes WHERE slug = ?').get(finalSlug);
    if (checkSlug) {
      finalSlug = `${finalSlug}-${Math.floor(Math.random() * 899 + 100)}`;
    }

    const codigoAcceso = `acc_${crypto.randomBytes(4).toString('hex')}`;

    const stmt = db.prepare(`
      INSERT INTO clientes (
        nombre, slug, codigo_acceso, descripcion, telefono_whatsapp, email, logo_url, portada_url, color_primario, moneda_simbolo, moneda_codigo, activo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const result = stmt.run(
      nombre.trim(),
      finalSlug,
      codigoAcceso,
      (descripcion || '').trim(),
      (telefono_whatsapp || '').trim(),
      (email || '').trim(),
      (logo_url || '').trim(),
      (portada_url || '').trim(),
      color_primario || '#4f46e5',
      (moneda_simbolo || '$').trim(),
      (moneda_codigo || 'USD').trim()
    );

    return this.getById(result.lastInsertRowid);
  }

  /**
   * Actualiza los datos de un cliente incluyendo moneda, logotipo y foto de portada
   */
  static update(id, { nombre, slug, descripcion, telefono_whatsapp, email, logo_url, portada_url, color_primario, moneda_simbolo, moneda_codigo, activo }) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error('Cliente no encontrado.');
    }

    let finalSlug = existing.slug;
    if (slug && slug.trim() !== '') {
      finalSlug = this.generateSlug(slug);
      const checkSlug = db.prepare('SELECT id FROM clientes WHERE slug = ? AND id != ?').get(finalSlug, Number(id));
      if (checkSlug) {
        throw new Error(`El slug '${finalSlug}' ya está en uso por otro cliente.`);
      }
    }

    const newNombre = nombre !== undefined ? nombre.trim() : existing.nombre;
    const newDesc = descripcion !== undefined ? descripcion.trim() : existing.descripcion;
    const newTel = telefono_whatsapp !== undefined ? telefono_whatsapp.trim() : existing.telefono_whatsapp;
    const newEmail = email !== undefined ? email.trim() : existing.email;
    const newLogo = logo_url !== undefined ? logo_url.trim() : existing.logo_url;
    const newPortada = portada_url !== undefined ? portada_url.trim() : existing.portada_url;
    const newColor = color_primario !== undefined ? color_primario.trim() : existing.color_primario;
    const newSimbolo = moneda_simbolo !== undefined ? moneda_simbolo.trim() : existing.moneda_simbolo;
    const newCodigo = moneda_codigo !== undefined ? moneda_codigo.trim() : existing.moneda_codigo;
    const newActivo = activo !== undefined ? (activo ? 1 : 0) : existing.activo;

    const stmt = db.prepare(`
      UPDATE clientes SET
        nombre = ?,
        slug = ?,
        descripcion = ?,
        telefono_whatsapp = ?,
        email = ?,
        logo_url = ?,
        portada_url = ?,
        color_primario = ?,
        moneda_simbolo = ?,
        moneda_codigo = ?,
        activo = ?,
        updated_at = (datetime('now', 'localtime'))
      WHERE id = ?
    `);

    stmt.run(newNombre, finalSlug, newDesc, newTel, newEmail, newLogo, newPortada, newColor, newSimbolo, newCodigo, newActivo, Number(id));
    return this.getById(id);
  }

  /**
   * Elimina un cliente y todos los productos asociados
   */
  static delete(id) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error('Cliente no encontrado.');
    }

    db.prepare('DELETE FROM productos WHERE cliente_id = ?').run(Number(id));
    db.prepare('DELETE FROM clientes WHERE id = ?').run(Number(id));

    return { success: true, deleted: existing };
  }
}

module.exports = ClienteService;
