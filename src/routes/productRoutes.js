const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ProductService = require('../services/productService');
const SupabaseCatalogStore = require('../services/supabaseCatalogStore');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload');
const { supabase, supabaseAdmin } = require('../lib/supabaseClient');
const {
  parseXlsxBuffer,
  parseCsvText,
  mapMatrixToProducts,
  generateXlsxTemplateBuffer,
  generateCsvTemplateString
} = require('../utils/spreadsheetParser');

// Middleware en memoria para procesar hojas de cálculo (.xlsx y .csv)
const uploadSpreadsheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Middleware para soportar subida de una o múltiples imágenes por producto
const uploadProductImages = upload.fields([
  { name: 'imagen', maxCount: 20 },
  { name: 'imagenes', maxCount: 20 }
]);

/**
 * Extrae todos los archivos subidos por Multer (ya sea vía req.file o req.files)
 */
function extractUploadedFiles(req) {
  const files = [];
  if (req.file) {
    files.push(req.file);
  }
  if (req.files) {
    if (Array.isArray(req.files)) {
      files.push(...req.files);
    } else {
      if (Array.isArray(req.files.imagen)) files.push(...req.files.imagen);
      if (Array.isArray(req.files.imagenes)) files.push(...req.files.imagenes);
    }
  }
  return files;
}

/**
 * Resuelve y sube las imágenes de un producto (combinando URLs de Storage/externas y archivos subidos desde PC)
 * respetando el orden exacto elegido por el Super-Admin.
 */
async function resolveProductImagesFromRequest(req, targetFolder = 'subidas') {
  const uploadedFiles = extractUploadedFiles(req);
  const uploadedUrls = [];

  for (const file of uploadedFiles) {
    const url = await SupabaseCatalogStore.uploadMulterFile(file, targetFolder);
    if (url) uploadedUrls.push(url);
  }

  let rawImagenes = req.body.imagenes;
  if (typeof rawImagenes === 'string') {
    const trimmed = rawImagenes.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        rawImagenes = JSON.parse(trimmed);
      } catch (_) {}
    }
  }

  const combinedList = [];
  const usedUploadIndices = new Set();

  const processEntry = (entry) => {
    if (!entry) return;
    if (Array.isArray(entry)) {
      entry.forEach(processEntry);
      return;
    }
    const str = String(entry).trim();
    if (!str) return;
    const tokenMatch = /^__UPLOAD_FILE_(\d+)__$/.exec(str);
    if (tokenMatch) {
      const idx = parseInt(tokenMatch[1], 10);
      if (uploadedUrls[idx]) {
        combinedList.push(uploadedUrls[idx]);
        usedUploadIndices.add(idx);
      }
      return;
    }
    combinedList.push(str);
  };

  processEntry(rawImagenes);

  // Agregar archivos subidos que no hayan sido referenciados mediante marcador de posición
  uploadedUrls.forEach((url, idx) => {
    if (!usedUploadIndices.has(idx)) {
      combinedList.push(url);
    }
  });

  if (req.body.imagen_url && typeof req.body.imagen_url === 'string' && req.body.imagen_url.trim()) {
    processEntry(req.body.imagen_url.trim());
  }

  return SupabaseCatalogStore.normalizeImagesInput(combinedList, null);
}

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
 * GET /api/products/bulk/template
 * Descarga plantilla Excel (.xlsx) o CSV (.csv) para carga masiva de productos por tienda.
 * Si se pasa ?folder=Marys&prefill=true (con token de admin), pre-llena las filas con las fotos de esa carpeta en Storage.
 */
router.get('/products/bulk/template', async (req, res) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const folder = String(req.query.folder || '').trim();
    const prefill = req.query.prefill === 'true';

    let sampleRows = null;
    if (prefill && folder && SupabaseCatalogStore.isAvailable) {
      try {
        const storageData = await SupabaseCatalogStore.listStorageContents({
          bucket: 'productos',
          prefix: folder
        });
        if (storageData && Array.isArray(storageData.files) && storageData.files.length > 0) {
          sampleRows = [
            ['nombre', 'categoria', 'precio', 'precio_mayor', 'inventario', 'descripcion', 'imagen_url'],
            ...storageData.files.map((f, idx) => {
              const cleanTitle = path
                .basename(f.name, path.extname(f.name))
                .replace(/[_-]+/g, ' ')
                .trim();
              return [
                cleanTitle || `Producto ${idx + 1}`,
                'General',
                format === 'csv' ? '10.00' : 10,
                format === 'csv' ? '' : '',
                format === 'csv' ? '10' : 10,
                '',
                f.url
              ];
            })
          ];
        }
      } catch (_) {}
    }

    const safeSuffix = folder ? `_${folder.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';

    if (format === 'csv') {
      const csvContent = generateCsvTemplateString(sampleRows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="plantilla_productos${safeSuffix}.csv"`);
      return res.send(csvContent);
    }

    const xlsxBuffer = generateXlsxTemplateBuffer(sampleRows);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="plantilla_productos${safeSuffix}.xlsx"`);
    return res.send(xlsxBuffer);
  } catch (error) {
    console.error('Error generando plantilla masiva:', error);
    return res.status(500).json({ success: false, error: 'No se pudo generar la plantilla.' });
  }
});

/**
 * POST /api/products/bulk/parse
 * Analiza un archivo Excel (.xlsx) o CSV (.csv) y devuelve las filas listas para previsualizar
 * vinculando opcionalmente nombres de imágenes con la carpeta de la tienda en Supabase Storage.
 */
router.post('/products/bulk/parse', authMiddleware, uploadSpreadsheet.single('archivo'), async (req, res) => {
  try {
    const storageFolder = String(req.body.storage_folder || req.query.storage_folder || '').trim();
    let storageFiles = [];

    if (storageFolder && SupabaseCatalogStore.isAvailable) {
      try {
        const contents = await SupabaseCatalogStore.listStorageContents({
          bucket: 'productos',
          prefix: storageFolder
        });
        storageFiles = contents.files || [];
      } catch (_) {}
    }

    let matrix = [];
    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      const isXlsxHeader =
        req.file.buffer &&
        req.file.buffer.length >= 4 &&
        req.file.buffer[0] === 0x50 &&
        req.file.buffer[1] === 0x4b;

      if (ext === '.xlsx' || isXlsxHeader) {
        matrix = parseXlsxBuffer(req.file.buffer);
      } else {
        matrix = parseCsvText(req.file.buffer.toString('utf8'));
      }
    } else if (req.body && req.body.csv_text) {
      matrix = parseCsvText(req.body.csv_text);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Envíe un archivo Excel (.xlsx) o CSV (.csv) válido para procesar.'
      });
    }

    const parsedProducts = mapMatrixToProducts(matrix, { storageFiles });
    if (parsedProducts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'El archivo no contiene filas de productos válidas. Verifique los encabezados (nombre, categoria, precio, precio_mayor, inventario, descripcion, imagen_url).'
      });
    }

    return res.json({
      success: true,
      count: parsedProducts.length,
      storage_folder: storageFolder,
      data: parsedProducts
    });
  } catch (error) {
    console.error('Error al parsear archivo masivo:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'No se pudo leer el archivo Excel/CSV.'
    });
  }
});

/**
 * POST /api/products/bulk
 * Importa masivamente un lote de productos asignándolos exclusivamente a la tienda indicada (cliente_id).
 * Soporta tanto JSON ({ cliente_id, products: [...] }) como subida directa de archivo Excel/CSV.
 */
router.post('/products/bulk', authMiddleware, uploadSpreadsheet.single('archivo'), async (req, res) => {
  try {
    const cliente_id = req.body.cliente_id || req.query.cliente_id;
    if (!cliente_id || cliente_id === 'all' || isNaN(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Debe seleccionar una tienda específica (cliente_id) para importar los productos. Cada tienda maneja su propio catálogo independiente.'
      });
    }

    let productsToInsert = [];

    if (Array.isArray(req.body.products)) {
      productsToInsert = req.body.products;
    } else if (typeof req.body.products === 'string') {
      try {
        productsToInsert = JSON.parse(req.body.products);
      } catch (_) {}
    } else if (req.file) {
      const storageFolder = String(req.body.storage_folder || '').trim();
      let storageFiles = [];
      if (storageFolder && SupabaseCatalogStore.isAvailable) {
        try {
          const contents = await SupabaseCatalogStore.listStorageContents({
            bucket: 'productos',
            prefix: storageFolder
          });
          storageFiles = contents.files || [];
        } catch (_) {}
      }

      const ext = path.extname(req.file.originalname || '').toLowerCase();
      const isXlsxHeader =
        req.file.buffer &&
        req.file.buffer.length >= 4 &&
        req.file.buffer[0] === 0x50 &&
        req.file.buffer[1] === 0x4b;

      const matrix =
        ext === '.xlsx' || isXlsxHeader
          ? parseXlsxBuffer(req.file.buffer)
          : parseCsvText(req.file.buffer.toString('utf8'));

      productsToInsert = mapMatrixToProducts(matrix, { storageFiles });
    }

    if (!Array.isArray(productsToInsert) || productsToInsert.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No se recibieron productos válidos para importar.'
      });
    }

    const result = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.createProductsBulk(cliente_id, productsToInsert)
      : ProductService.createBulk(cliente_id, productsToInsert);

    return res.status(201).json({
      success: true,
      message: `Se importaron ${result.count} producto(s) exitosamente en el catálogo de "${result.client.nombre}".`,
      cliente_id: Number(cliente_id),
      cliente_nombre: result.client.nombre,
      count: result.count,
      data: result.products
    });
  } catch (error) {
    console.error('Error en carga masiva POST /api/products/bulk:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Error al realizar la carga masiva de productos.'
    });
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
 * Crear producto vinculado a un cliente específico en Supabase (soporta múltiples imágenes)
 */
router.post('/products', authMiddleware, uploadProductImages, async (req, res) => {
  try {
    const { cliente_id, nombre, descripcion, precio, precio_mayor, inventario, mostrar_stock, categoria } = req.body;

    let targetFolder = 'subidas';
    if (SupabaseCatalogStore.isAvailable && cliente_id) {
      const clientObj = await SupabaseCatalogStore.getClientById(cliente_id).catch(() => null);
      if (clientObj && clientObj.slug) {
        targetFolder = clientObj.slug;
      }
    }

    const { imagen_url: finalImageUrl, imagenes: finalImages } = await resolveProductImagesFromRequest(
      req,
      targetFolder
    );

    const newProduct = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.createProduct({
          cliente_id,
          nombre,
          descripcion,
          precio,
          precio_mayor,
          inventario,
          mostrar_stock,
          categoria,
          imagen_url: finalImageUrl,
          imagenes: finalImages
        })
      : ProductService.create({
          cliente_id: cliente_id || 1,
          nombre,
          descripcion,
          precio,
          precio_mayor,
          inventario,
          mostrar_stock,
          categoria,
          imagen_url: finalImageUrl,
          imagenes: finalImages
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
 * Actualizar datos e imágenes de un producto
 */
router.put('/products/:id', authMiddleware, uploadProductImages, async (req, res) => {
  try {
    const { cliente_id, nombre, descripcion, precio, precio_mayor, inventario, mostrar_stock, categoria } = req.body;

    let targetFolder = 'subidas';
    if (SupabaseCatalogStore.isAvailable && cliente_id) {
      const clientObj = await SupabaseCatalogStore.getClientById(cliente_id).catch(() => null);
      if (clientObj && clientObj.slug) {
        targetFolder = clientObj.slug;
      }
    }

    const hasImagePayload =
      req.body.imagenes !== undefined ||
      req.body.imagen_url !== undefined ||
      extractUploadedFiles(req).length > 0;

    let finalImageUrl;
    let finalImages;
    if (hasImagePayload) {
      const resolved = await resolveProductImagesFromRequest(req, targetFolder);
      finalImageUrl = resolved.imagen_url;
      finalImages = resolved.imagenes;
    }

    const updated = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.updateProduct(req.params.id, {
          cliente_id,
          nombre,
          descripcion,
          precio,
          precio_mayor,
          inventario,
          mostrar_stock,
          categoria,
          imagen_url: finalImageUrl,
          imagenes: finalImages
        })
      : ProductService.update(req.params.id, {
          cliente_id,
          nombre,
          descripcion,
          precio,
          precio_mayor,
          inventario,
          mostrar_stock,
          categoria,
          imagen_url: finalImageUrl,
          imagenes: finalImages
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
 * Subida directa de una o varias imágenes hacia una carpeta de Supabase Storage (ej: ?folder=Marys)
 */
router.post('/admin/upload-image', authMiddleware, uploadProductImages, async (req, res) => {
  try {
    const files = extractUploadedFiles(req);
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: 'No se envió ningún archivo de imagen.' });
    }

    const folder = req.body.folder || req.query.folder || 'subidas';
    const bucket = req.body.bucket || req.query.bucket || 'productos';
    const urls = [];
    for (const file of files) {
      const publicUrl = await SupabaseCatalogStore.uploadMulterFile(file, folder, bucket);
      if (publicUrl) urls.push(publicUrl);
    }

    return res.json({
      success: true,
      message:
        urls.length > 1
          ? `${urls.length} imágenes subidas correctamente a Storage.`
          : 'Imagen subida correctamente a Storage.',
      url: urls[0] || '',
      urls,
      filename: files[0].filename,
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
    const resolvedImages = await resolveProductImagesFromRequest(req, 'subidas');
    const imagen_url = resolvedImages.imagen_url;
    const imagenes = resolvedImages.imagenes;

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
    if (created && created.id) {
      const meta = await SupabaseCatalogStore._loadMeta(true);
      const parsedMayor =
        precio_mayor !== undefined && precio_mayor !== null && precio_mayor !== '' && !isNaN(Number(precio_mayor)) && Number(precio_mayor) > 0
          ? Number(Number(precio_mayor).toFixed(2))
          : null;
      const parsedMostrarStock = SupabaseCatalogStore.parseMostrarStock(req.body.mostrar_stock, false);
      meta.products[String(created.id)] = {
        categoria: categoria ? String(categoria).trim() : 'General',
        precio_mayor: parsedMayor,
        mostrar_stock: parsedMostrarStock,
        imagenes
      };
      await SupabaseCatalogStore._saveMeta(meta);
      created.imagenes = imagenes;
      created.mostrar_stock = parsedMostrarStock;
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

router.post('/productos', authMiddleware, uploadProductImages, handleRegisterSupabaseProducto);
router.post('/supabase/productos', authMiddleware, uploadProductImages, handleRegisterSupabaseProducto);
router.post('/supabase/products', authMiddleware, uploadProductImages, handleRegisterSupabaseProducto);

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
