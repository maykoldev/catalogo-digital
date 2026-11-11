const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config/config');

class ProductService {
  /**
   * Obtiene productos con soporte para filtrado por cliente/empresa, búsqueda y ordenamiento
   */
  static getAll({ cliente_id, cliente_slug, search, categoria, minPrecio, maxPrecio, inStock, sortBy = 'id', sortOrder = 'ASC' } = {}) {
    let query = `
      SELECT 
        p.*,
        c.nombre as cliente_nombre,
        c.slug as cliente_slug
      FROM productos p
      JOIN clientes c ON p.cliente_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (cliente_id && cliente_id !== 'all') {
      query += ' AND p.cliente_id = ?';
      params.push(Number(cliente_id));
    } else if (cliente_slug && cliente_slug !== 'all') {
      query += ' AND c.slug = ?';
      params.push(cliente_slug.trim());
    }

    if (search && search.trim() !== '') {
      query += ' AND (p.nombre LIKE ? OR p.descripcion LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term);
    }

    if (categoria && categoria !== 'all' && categoria !== '') {
      query += ' AND p.categoria = ?';
      params.push(categoria);
    }

    if (minPrecio !== undefined && minPrecio !== '') {
      query += ' AND p.precio >= ?';
      params.push(Number(minPrecio));
    }

    if (maxPrecio !== undefined && maxPrecio !== '') {
      query += ' AND p.precio <= ?';
      params.push(Number(maxPrecio));
    }

    if (inStock === 'true' || inStock === true) {
      query += ' AND p.inventario > 0';
    }

    const allowedSort = ['id', 'nombre', 'precio', 'inventario', 'categoria', 'created_at'];
    const safeSort = allowedSort.includes(sortBy) ? `p.${sortBy}` : 'p.id';
    const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    query += ` ORDER BY ${safeSort} ${safeOrder}`;

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  /**
   * Obtiene un producto individual junto con los datos de su cliente asociado
   */
  static getById(id) {
    const stmt = db.prepare(`
      SELECT p.*, c.nombre as cliente_nombre, c.slug as cliente_slug, c.telefono_whatsapp as cliente_whatsapp
      FROM productos p
      JOIN clientes c ON p.cliente_id = c.id
      WHERE p.id = ?
    `);
    return stmt.get(Number(id));
  }

  /**
   * Crea un producto asociado a un cliente específico
   */
  static create({ cliente_id, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url }) {
    if (!cliente_id) {
      throw new Error('Debe especificar el cliente o empresa al que pertenece el producto.');
    }
    if (!nombre || nombre.trim() === '') {
      throw new Error('El nombre del producto es obligatorio.');
    }
    if (precio === undefined || isNaN(precio) || Number(precio) < 0) {
      throw new Error('El precio debe ser un número mayor o igual a 0.');
    }
    if (inventario === undefined || isNaN(inventario) || Number(inventario) < 0) {
      throw new Error('El inventario debe ser un número entero mayor o igual a 0.');
    }
    if (!categoria || categoria.trim() === '') {
      throw new Error('La categoría es obligatoria.');
    }

    // Verificar que el cliente existe
    const clientExists = db.prepare('SELECT id FROM clientes WHERE id = ?').get(Number(cliente_id));
    if (!clientExists) {
      throw new Error('El cliente especificado no existe.');
    }

    const parsedMayor =
      precio_mayor !== undefined && precio_mayor !== null && precio_mayor !== '' && !isNaN(Number(precio_mayor)) && Number(precio_mayor) > 0
        ? Number(Number(precio_mayor).toFixed(2))
        : null;

    const stmt = db.prepare(`
      INSERT INTO productos (cliente_id, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      Number(cliente_id),
      nombre.trim(),
      (descripcion || '').trim(),
      Number(precio),
      parsedMayor,
      Math.floor(Number(inventario)),
      categoria.trim(),
      (imagen_url || '/placeholder.png').trim()
    );

    return this.getById(result.lastInsertRowid);
  }

  /**
   * Crea múltiples productos en lote para un cliente específico (respaldo SQLite)
   */
  static createBulk(cliente_id, productsList = []) {
    if (!cliente_id || isNaN(Number(cliente_id)) || Number(cliente_id) <= 0) {
      throw new Error('Debe seleccionar una tienda/catálogo específico para realizar la carga masiva.');
    }

    const parsedClienteId = Number(cliente_id);
    const client = db.prepare('SELECT * FROM clientes WHERE id = ?').get(parsedClienteId);
    if (!client) {
      throw new Error('La tienda seleccionada no existe.');
    }

    if (!Array.isArray(productsList) || productsList.length === 0) {
      throw new Error('No se encontraron productos válidos para importar.');
    }

    const stmt = db.prepare(`
      INSERT INTO productos (cliente_id, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
      const created = [];
      for (const raw of items) {
        const nombre = String(raw.nombre || '').trim();
        if (!nombre) continue;
        const rawPrice = Number(raw.precio);
        const precio = !isNaN(rawPrice) && rawPrice >= 0 ? Number(rawPrice.toFixed(2)) : 0;
        const rawMayor = raw.precio_mayor !== undefined && raw.precio_mayor !== null && raw.precio_mayor !== ''
          ? Number(raw.precio_mayor)
          : null;
        const precio_mayor = rawMayor !== null && !isNaN(rawMayor) && rawMayor > 0 ? Number(rawMayor.toFixed(2)) : null;
        const rawInv = raw.inventario !== undefined && raw.inventario !== null && raw.inventario !== ''
          ? Number(raw.inventario)
          : 10;
        const inventario = !isNaN(rawInv) && rawInv >= 0 ? Math.floor(rawInv) : 10;
        const categoria = raw.categoria && String(raw.categoria).trim() ? String(raw.categoria).trim() : 'General';
        const descripcion = raw.descripcion ? String(raw.descripcion).trim() : '';
        const imagen_url =
          raw.imagen_url && String(raw.imagen_url).trim()
            ? String(raw.imagen_url).trim()
            : 'https://placehold.co/400x400/e2e8f0/475569?text=Producto';

        const res = stmt.run(parsedClienteId, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url);
        created.push(this.getById(res.lastInsertRowid));
      }
      return created;
    });

    const products = insertMany(productsList);
    if (products.length === 0) {
      throw new Error('Ninguna fila contiene un nombre de producto válido para importar.');
    }

    return {
      client,
      count: products.length,
      products
    };
  }

  /**
   * Actualiza los datos de un producto
   */
  static update(id, { cliente_id, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url }) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error('Producto no encontrado.');
    }

    const newClienteId = cliente_id ? Number(cliente_id) : existing.cliente_id;
    const newNombre = nombre !== undefined ? nombre.trim() : existing.nombre;
    const newDesc = descripcion !== undefined ? descripcion.trim() : existing.descripcion;
    const newPrecio = precio !== undefined ? Number(precio) : existing.precio;
    const newPrecioMayor =
      precio_mayor !== undefined
        ? precio_mayor !== null && precio_mayor !== '' && !isNaN(Number(precio_mayor)) && Number(precio_mayor) > 0
          ? Number(Number(precio_mayor).toFixed(2))
          : null
        : existing.precio_mayor;
    const newInventario = inventario !== undefined ? Math.floor(Number(inventario)) : existing.inventario;
    const newCat = categoria !== undefined ? categoria.trim() : existing.categoria;
    const newImg = imagen_url !== undefined ? imagen_url.trim() : existing.imagen_url;

    if (newPrecio < 0) throw new Error('El precio no puede ser negativo.');
    if (newInventario < 0) throw new Error('El inventario no puede ser negativo.');

    const stmt = db.prepare(`
      UPDATE productos
      SET cliente_id = ?, nombre = ?, descripcion = ?, precio = ?, precio_mayor = ?, inventario = ?, categoria = ?, imagen_url = ?, updated_at = (datetime('now', 'localtime'))
      WHERE id = ?
    `);

    stmt.run(newClienteId, newNombre, newDesc, newPrecio, newPrecioMayor, newInventario, newCat, newImg, Number(id));
    return this.getById(id);
  }

  /**
   * Ajuste rápido de inventario (+ / -)
   */
  static adjustStock(id, { delta, absolute }) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error('Producto no encontrado.');
    }

    let nextStock = existing.inventario;
    if (absolute !== undefined) {
      nextStock = Math.floor(Number(absolute));
    } else if (delta !== undefined) {
      nextStock += Math.floor(Number(delta));
    }

    if (nextStock < 0) nextStock = 0;

    const stmt = db.prepare(`
      UPDATE productos
      SET inventario = ?, updated_at = (datetime('now', 'localtime'))
      WHERE id = ?
    `);
    stmt.run(nextStock, Number(id));
    return this.getById(id);
  }

  /**
   * Elimina un producto por su ID
   */
  static delete(id) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error('Producto no encontrado.');
    }

    const stmt = db.prepare('DELETE FROM productos WHERE id = ?');
    stmt.run(Number(id));
    return { success: true, deleted: existing };
  }

  /**
   * Obtiene la lista de categorías (opcionalmente filtrada por cliente)
   */
  static getCategories(clienteId = null) {
    let query = 'SELECT categoria, COUNT(*) as count FROM productos';
    const params = [];

    if (clienteId && clienteId !== 'all') {
      query += ' WHERE cliente_id = ?';
      params.push(Number(clienteId));
    }

    query += ' GROUP BY categoria ORDER BY count DESC';
    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  /**
   * Estadísticas agregadas globales o por cliente específico
   */
  static getStats(clienteId = null) {
    let query = `
      SELECT 
        COUNT(*) as total_productos,
        COALESCE(SUM(inventario), 0) as total_unidades,
        COALESCE(SUM(precio * inventario), 0) as valor_total_inventario,
        COUNT(CASE WHEN inventario <= 5 AND inventario > 0 THEN 1 END) as stock_bajo,
        COUNT(CASE WHEN inventario = 0 THEN 1 END) as agotados
      FROM productos
    `;
    const params = [];

    if (clienteId && clienteId !== 'all') {
      query += ' WHERE cliente_id = ?';
      params.push(Number(clienteId));
    }

    const summary = db.prepare(query).get(...params);
    const categories = this.getCategories(clienteId);

    return {
      total_productos: summary.total_productos,
      total_unidades: summary.total_unidades,
      valor_total_inventario: Number(summary.valor_total_inventario.toFixed(2)),
      stock_bajo: summary.stock_bajo,
      agotados: summary.agotados,
      categorias: categories
    };
  }

  /**
   * Escanea el directorio 'productos' para imágenes disponibles
   */
  static getLocalImages() {
    if (!fs.existsSync(config.PRODUCTOS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(config.PRODUCTOS_DIR);
    const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];

    return files
      .filter(file => validExtensions.includes(path.extname(file).toLowerCase()))
      .map(file => {
        const fullPath = path.join(config.PRODUCTOS_DIR, file);
        const stats = fs.statSync(fullPath);
        return {
          filename: file,
          url: `/productos/${encodeURIComponent(file)}`,
          sizeKb: Math.round(stats.size / 1024),
          modifiedAt: stats.mtime
        };
      });
  }
}

module.exports = ProductService;
