const express = require('express');
const router = express.Router();
const ProductService = require('../services/productService');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload');
const { supabase, supabaseAdmin } = require('../lib/supabaseClient');

// ==========================================
// RUTAS DE PRODUCTOS (Consulta)
// ==========================================

/**
 * GET /api/products
 * Lista de productos filtrados por cliente, categoría, búsqueda o stock
 */
router.get('/products', (req, res) => {
  try {
    const { cliente_id, cliente_slug, search, categoria, minPrecio, maxPrecio, inStock, sortBy, sortOrder } = req.query;
    const products = ProductService.getAll({
      cliente_id,
      cliente_slug,
      search,
      categoria,
      minPrecio,
      maxPrecio,
      inStock,
      sortBy,
      sortOrder
    });
    return res.json({ success: true, count: products.length, data: products });
  } catch (error) {
    console.error('Error al obtener productos:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/products/:id
 * Detalle de un producto individual
 */
router.get('/products/:id', (req, res) => {
  try {
    const product = ProductService.getById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado.' });
    }
    return res.json({ success: true, data: product });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/categories
 * Categorías disponibles (opcionalmente filtradas por cliente_id)
 */
router.get('/categories', (req, res) => {
  try {
    const { cliente_id } = req.query;
    const categories = ProductService.getCategories(cliente_id);
    return res.json({ success: true, data: categories });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================
// RUTAS PRIVADAS (Super-Admin)
// ====================================================

/**
 * POST /api/products
 * Crear producto vinculado a un cliente específico
 */
router.post('/products', authMiddleware, upload.single('imagen'), (req, res) => {
  try {
    const { cliente_id, nombre, descripcion, precio, inventario, categoria, imagen_url } = req.body;

    let finalImageUrl = imagen_url;
    if (req.file) {
      finalImageUrl = `/productos/${encodeURIComponent(req.file.filename)}`;
    }

    if (!finalImageUrl) {
      finalImageUrl = '/productos/placeholder.png';
    }

    const newProduct = ProductService.create({
      cliente_id: cliente_id || 1,
      nombre,
      descripcion,
      precio,
      inventario,
      categoria,
      imagen_url: finalImageUrl
    });

    return res.status(201).json({
      success: true,
      message: 'Producto creado exitosamente.',
      data: newProduct
    });
  } catch (error) {
    console.error('Error al crear producto:', error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/products/:id
 * Actualizar datos de un producto
 */
router.put('/products/:id', authMiddleware, upload.single('imagen'), (req, res) => {
  try {
    const { cliente_id, nombre, descripcion, precio, inventario, categoria, imagen_url } = req.body;

    let finalImageUrl = imagen_url;
    if (req.file) {
      finalImageUrl = `/productos/${encodeURIComponent(req.file.filename)}`;
    }

    const updated = ProductService.update(req.params.id, {
      cliente_id,
      nombre,
      descripcion,
      precio,
      inventario,
      categoria,
      imagen_url: finalImageUrl
    });

    return res.json({
      success: true,
      message: 'Producto actualizado con éxito.',
      data: updated
    });
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/products/:id/stock
 * Modificación rápida de inventario (+ / -)
 */
router.patch('/products/:id/stock', authMiddleware, (req, res) => {
  try {
    const { delta, absolute } = req.body;
    const updated = ProductService.adjustStock(req.params.id, { delta, absolute });
    return res.json({
      success: true,
      message: 'Inventario ajustado correctamente.',
      data: updated
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/products/:id
 * Eliminación de producto
 */
router.delete('/products/:id', authMiddleware, (req, res) => {
  try {
    const result = ProductService.delete(req.params.id);
    return res.json({
      success: true,
      message: 'Producto eliminado del catálogo.',
      data: result.deleted
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/images
 * Galería de imágenes físicas en /productos
 */
router.get('/admin/images', authMiddleware, (req, res) => {
  try {
    const images = ProductService.getLocalImages();
    return res.json({ success: true, count: images.length, data: images });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/upload-image
 * Subida directa de imágenes
 */
router.post('/admin/upload-image', authMiddleware, upload.single('imagen'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se envió ningún archivo de imagen.' });
    }

    const publicUrl = `/productos/${encodeURIComponent(req.file.filename)}`;
    return res.json({
      success: true,
      message: 'Imagen subida correctamente.',
      url: publicUrl,
      filename: req.file.filename
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

// ====================================================
// RUTAS DE INTEGRACIÓN DE PRODUCTOS CON SUPABASE
// ====================================================

/**
 * POST /api/productos (y /api/supabase/productos, /api/supabase/products)
 * Registra un nuevo producto en Supabase vinculado a un cliente/comercio.
 * Recibe en body: nombre, descripcion, precio, cliente_id, y opcionalmente imagen_url (o archivo).
 */
const handleRegisterSupabaseProducto = async (req, res) => {
  try {
    const { nombre, descripcion, precio, cliente_id } = req.body;
    let imagen_url = req.body.imagen_url || req.body.imagen || null;

    // Si se subió un archivo físico de imagen vía multipart/form-data
    if (req.file) {
      imagen_url = `/productos/${encodeURIComponent(req.file.filename)}`;
    }

    // 1. Validaciones básicas obligatorias (nombre, precio y cliente_id)
    if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
      return res.status(400).json({
        success: false,
        error: 'El campo "nombre" es obligatorio y debe ser un texto válido.'
      });
    }

    if (precio === undefined || precio === null || precio === '' || isNaN(Number(precio)) || Number(precio) < 0) {
      return res.status(400).json({
        success: false,
        error: 'El campo "precio" es obligatorio y debe ser un número válido mayor o igual a 0.'
      });
    }

    if (cliente_id === undefined || cliente_id === null || cliente_id === '' || isNaN(Number(cliente_id)) || !Number.isInteger(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El campo "cliente_id" es obligatorio y debe ser un número entero positivo correspondiente al comercio.'
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        error: 'El cliente supabaseAdmin no está disponible. Verifique SUPABASE_SERVICE_ROLE_KEY en .env.'
      });
    }

    const parsedClienteId = parseInt(cliente_id, 10);
    const parsedPrecio = parseFloat(Number(precio).toFixed(2));
    const parsedDescripcion = descripcion && typeof descripcion === 'string' && descripcion.trim() !== ''
      ? descripcion.trim()
      : null;

    // Si se envía inventario, respetarlo; de lo contrario, usar 10 por defecto (disponible en catálogo)
    const parsedInventario = req.body.inventario !== undefined && req.body.inventario !== null && req.body.inventario !== '' && !isNaN(Number(req.body.inventario))
      ? parseInt(req.body.inventario, 10)
      : 10;

    const recordToInsert = {
      cliente_id: parsedClienteId,
      nombre: nombre.trim(),
      descripcion: parsedDescripcion,
      precio: parsedPrecio,
      inventario: parsedInventario,
      imagen_url: imagen_url ? String(imagen_url).trim() : null
    };

    // 2. Inserción en la tabla 'productos' en Supabase
    const { data, error } = await supabaseAdmin
      .from('productos')
      .insert([recordToInsert])
      .select();

    if (error) {
      console.error('Error insertando producto en Supabase:', error);

      // Violación de clave foránea (cliente_id no existe en tabla clientes)
      if (error.code === '23503') {
        return res.status(404).json({
          success: false,
          error: `El comercio con cliente_id ${parsedClienteId} no existe en Supabase. Registre primero el cliente antes de asociar productos.`,
          code: error.code
        });
      }

      return res.status(500).json({
        success: false,
        error: error.message || 'Error al insertar el producto en Supabase.',
        details: error
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Producto registrado exitosamente en Supabase.',
      data: data && data[0] ? data[0] : recordToInsert
    });
  } catch (err) {
    console.error('Excepción al registrar producto en Supabase:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del servidor al registrar producto.'
    });
  }
};

router.post('/productos', upload.single('imagen'), handleRegisterSupabaseProducto);
router.post('/supabase/productos', upload.single('imagen'), handleRegisterSupabaseProducto);
router.post('/supabase/products', upload.single('imagen'), handleRegisterSupabaseProducto);

/**
 * GET /api/productos/:cliente_id (y /api/clientes/:cliente_id/productos, /api/productos/cliente/:cliente_id)
 * Obtiene todos los productos asociados a un comercio (cliente_id) desde Supabase.
 * Usa el cliente `supabase` para consultar la tabla 'productos' filtrando por dicha columna.
 */
const handleGetSupabaseProductosByCliente = async (req, res) => {
  try {
    const { cliente_id } = req.params;

    // Validación del parámetro cliente_id en la URL
    if (!cliente_id || isNaN(Number(cliente_id)) || !Number.isInteger(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El parámetro "cliente_id" en la URL debe ser un número entero positivo válido.'
      });
    }

    const parsedClienteId = parseInt(cliente_id, 10);

    // Respaldo opcional para catálogos demostrativos locales cuando el frontend indica ?source=local
    if (req.query.source === 'local') {
      const localProducts = ProductService.getAll({ cliente_id: parsedClienteId });
      return res.status(200).json({
        success: true,
        source: 'local',
        cliente_id: parsedClienteId,
        total: localProducts.length,
        productos: localProducts
      });
    }

    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'El cliente supabase no está inicializado. Verifique la configuración de Supabase en .env.'
      });
    }

    // Consulta en Supabase con el cliente estándar filtrando por cliente_id
    let { data, error } = await supabase
      .from('productos')
      .select('*')
      .eq('cliente_id', parsedClienteId)
      .order('id', { ascending: true });

    // Si data está vacío y supabaseAdmin está disponible, verificar si RLS en Supabase restringe la lectura anónima
    if (!error && (!data || data.length === 0) && supabaseAdmin) {
      const adminFallback = await supabaseAdmin
        .from('productos')
        .select('*')
        .eq('cliente_id', parsedClienteId)
        .order('id', { ascending: true });
      if (adminFallback.data && adminFallback.data.length > 0) {
        data = adminFallback.data;
      }
    }

    // Manejo de error si falla la conexión o la consulta en Supabase (retorna 500)
    if (error) {
      console.error(`Error al consultar productos para el comercio ${parsedClienteId} en Supabase:`, error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Error al consultar los productos en Supabase.',
        details: error
      });
    }

    // Retorna estado 200 con el listado de productos encontrados
    return res.status(200).json({
      success: true,
      cliente_id: parsedClienteId,
      total: data ? data.length : 0,
      productos: data || []
    });
  } catch (err) {
    console.error('Excepción al obtener productos en Supabase:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del servidor al procesar la solicitud.'
    });
  }
};

router.get('/productos/:cliente_id', handleGetSupabaseProductosByCliente);
router.get('/clientes/:cliente_id/productos', handleGetSupabaseProductosByCliente);
router.get('/productos/cliente/:cliente_id', handleGetSupabaseProductosByCliente);
router.get('/supabase/productos/:cliente_id', handleGetSupabaseProductosByCliente);

module.exports = router;
