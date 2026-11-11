const express = require('express');
const router = express.Router();
const ProductService = require('../services/productService');
const SupabaseCatalogStore = require('../services/supabaseCatalogStore');
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
router.get('/products', async (req, res) => {
  try {
    const { cliente_id, cliente_slug, search, categoria, minPrecio, maxPrecio, inStock, sortBy, sortOrder } = req.query;

    if (SupabaseCatalogStore.isAvailable) {
      const products = await SupabaseCatalogStore.getAllProducts({
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
    }

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
router.get('/products/:id', async (req, res) => {
  try {
    const product = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.getProductById(req.params.id)
      : ProductService.getById(req.params.id);

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
router.get('/categories', async (req, res) => {
  try {
    const { cliente_id } = req.query;
    const categories = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.getCategories(cliente_id)
      : ProductService.getCategories(cliente_id);
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
 * Crear producto vinculado a un cliente específico en Supabase
 */
router.post('/products', authMiddleware, upload.single('imagen'), async (req, res) => {
  try {
    const { cliente_id, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url } = req.body;

    let finalImageUrl = imagen_url;
    if (req.file) {
      let targetFolder = 'subidas';
      if (SupabaseCatalogStore.isAvailable && cliente_id) {
        const clientObj = await SupabaseCatalogStore.getClientById(cliente_id).catch(() => null);
        if (clientObj && clientObj.slug) {
          targetFolder = clientObj.slug;
        }
      }
      finalImageUrl = await SupabaseCatalogStore.uploadMulterFile(req.file, targetFolder);
    }

    if (!finalImageUrl) {
      finalImageUrl = 'https://placehold.co/400x400/e2e8f0/475569?text=Producto';
    }

    const newProduct = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.createProduct({
          cliente_id,
          nombre,
          descripcion,
          precio,
          precio_mayor,
          inventario,
          categoria,
          imagen_url: finalImageUrl
        })
      : ProductService.create({
          cliente_id: cliente_id || 1,
          nombre,
          descripcion,
          precio,
          precio_mayor,
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
router.put('/products/:id', authMiddleware, upload.single('imagen'), async (req, res) => {
  try {
    const { cliente_id, nombre, descripcion, precio, precio_mayor, inventario, categoria, imagen_url } = req.body;

    let finalImageUrl = imagen_url;
    if (req.file) {
      let targetFolder = 'subidas';
      if (SupabaseCatalogStore.isAvailable && cliente_id) {
        const clientObj = await SupabaseCatalogStore.getClientById(cliente_id).catch(() => null);
        if (clientObj && clientObj.slug) {
          targetFolder = clientObj.slug;
        }
      }
      finalImageUrl = await SupabaseCatalogStore.uploadMulterFile(req.file, targetFolder);
    }

    const updated = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.updateProduct(req.params.id, {
          cliente_id,
          nombre,
          descripcion,
          precio,
          precio_mayor,
          inventario,
          categoria,
          imagen_url: finalImageUrl
        })
      : ProductService.update(req.params.id, {
          cliente_id,
          nombre,
          descripcion,
          precio,
          precio_mayor,
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
router.patch('/products/:id/stock', authMiddleware, async (req, res) => {
  try {
    const { delta, absolute } = req.body;
    const updated = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.adjustProductStock(req.params.id, { delta, absolute })
      : ProductService.adjustStock(req.params.id, { delta, absolute });

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
router.delete('/products/:id', authMiddleware, async (req, res) => {
  try {
    const result = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.deleteProduct(req.params.id)
      : ProductService.delete(req.params.id);

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
 * GET /api/admin/storage
 * Explorador jerárquico de carpetas e imágenes en Supabase Storage (organizado por tienda/carpeta)
 * Query params opcionales: ?bucket=productos&prefix=Marys
 */
router.get('/admin/storage', authMiddleware, async (req, res) => {
  try {
    const bucket = req.query.bucket || 'productos';
    const prefix = req.query.prefix || req.query.folder || '';

    if (SupabaseCatalogStore.isAvailable) {
      const result = await SupabaseCatalogStore.listStorageContents({ bucket, prefix });
      return res.json({
        success: true,
        source: 'supabase_storage',
        ...result
      });
    }

    // Respaldo local si Supabase no estuviera conectado
    const localFiles = ProductService.getLocalImages();
    return res.json({
      success: true,
      source: 'local',
      bucket: 'local',
      buckets: [{ name: 'local', public: true }],
      prefix: '',
      breadcrumbs: [{ label: 'productos/', prefix: '' }],
      rootFolders: [],
      folders: [],
      files: localFiles.map((f) => ({
        name: f.filename,
        filename: f.filename,
        path: f.filename,
        folder: '',
        bucket: 'local',
        url: f.url,
        sizeKb: f.sizeKb
      }))
    });
  } catch (error) {
    console.error('Error en GET /api/admin/storage:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/images
 * Compatibilidad con listado de imágenes (ahora soporta también ?prefix=... desde Supabase Storage)
 */
router.get('/admin/images', authMiddleware, async (req, res) => {
  try {
    if (SupabaseCatalogStore.isAvailable) {
      const result = await SupabaseCatalogStore.listStorageContents({
        bucket: req.query.bucket || 'productos',
        prefix: req.query.prefix || ''
      });
      return res.json({
        success: true,
        count: result.files.length,
        folders: result.folders,
        rootFolders: result.rootFolders,
        prefix: result.prefix,
        bucket: result.bucket,
        data: result.files
      });
    }

    const images = ProductService.getLocalImages();
    return res.json({ success: true, count: images.length, folders: [], data: images });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/upload-image
 * Subida directa de imágenes hacia una carpeta de Supabase Storage (ej: ?folder=Marys)
 */
router.post('/admin/upload-image', authMiddleware, upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se envió ningún archivo de imagen.' });
    }

    const folder = req.body.folder || req.query.folder || 'subidas';
    const bucket = req.body.bucket || req.query.bucket || 'productos';
    const publicUrl = await SupabaseCatalogStore.uploadMulterFile(req.file, folder, bucket);

    return res.json({
      success: true,
      message: 'Imagen subida correctamente a Storage.',
      url: publicUrl,
      filename: req.file.filename,
      folder
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
 */
const handleRegisterSupabaseProducto = async (req, res) => {
  try {
    const { nombre, descripcion, precio, precio_mayor, cliente_id, categoria } = req.body;
    let imagen_url = req.body.imagen_url || req.body.imagen || null;

    if (req.file) {
      imagen_url = await SupabaseCatalogStore.uploadMulterFile(req.file, 'subidas');
    }

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

    if (
      cliente_id === undefined ||
      cliente_id === null ||
      cliente_id === '' ||
      isNaN(Number(cliente_id)) ||
      !Number.isInteger(Number(cliente_id)) ||
      Number(cliente_id) <= 0
    ) {
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
    const parsedDescripcion =
      descripcion && typeof descripcion === 'string' && descripcion.trim() !== ''
        ? descripcion.trim()
        : null;

    const parsedInventario =
      req.body.inventario !== undefined &&
      req.body.inventario !== null &&
      req.body.inventario !== '' &&
      !isNaN(Number(req.body.inventario))
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

    const { data, error } = await supabaseAdmin
      .from('productos')
      .insert([recordToInsert])
      .select();

    if (error) {
      console.error('Error insertando producto en Supabase:', error);

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

    const created = data && data[0] ? data[0] : recordToInsert;
    if ((categoria || precio_mayor !== undefined) && created && created.id) {
      const meta = await SupabaseCatalogStore._loadMeta(true);
      const parsedMayor =
        precio_mayor !== undefined && precio_mayor !== null && precio_mayor !== '' && !isNaN(Number(precio_mayor)) && Number(precio_mayor) > 0
          ? Number(Number(precio_mayor).toFixed(2))
          : null;
      meta.products[String(created.id)] = {
        categoria: categoria ? String(categoria).trim() : 'General',
        precio_mayor: parsedMayor
      };
      await SupabaseCatalogStore._saveMeta(meta);
    }

    return res.status(201).json({
      success: true,
      message: 'Producto registrado exitosamente en Supabase.',
      data: created
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
 * GET /api/productos/:cliente_id
 * Obtiene todos los productos asociados a un comercio (cliente_id) desde Supabase.
 */
const handleGetSupabaseProductosByCliente = async (req, res) => {
  try {
    const { cliente_id } = req.params;

    if (!cliente_id || isNaN(Number(cliente_id)) || !Number.isInteger(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El parámetro "cliente_id" en la URL debe ser un número entero positivo válido.'
      });
    }

    const parsedClienteId = parseInt(cliente_id, 10);

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

    let { data, error } = await supabase
      .from('productos')
      .select('*')
      .eq('cliente_id', parsedClienteId)
      .order('id', { ascending: true });

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

    if (error) {
      console.error(`Error al consultar productos para el comercio ${parsedClienteId} en Supabase:`, error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Error al consultar los productos en Supabase.',
        details: error
      });
    }

    const enrichedProducts = await SupabaseCatalogStore.enrichProductsList(data || []);

    return res.status(200).json({
      success: true,
      cliente_id: parsedClienteId,
      total: enrichedProducts.length,
      productos: enrichedProducts
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
