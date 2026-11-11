const express = require('express');
const router = express.Router();
const ClienteService = require('../services/clienteService');
const ProductService = require('../services/productService');
const SupabaseCatalogStore = require('../services/supabaseCatalogStore');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload');
const { supabase, supabaseAdmin } = require('../lib/supabaseClient');

// ==========================================
// RUTAS PÚBLICAS (Sin Autenticación)
// ==========================================

/**
 * GET /api/public/catalogo/:slugOrCode
 * Devuelve la información del catálogo de un cliente, su logotipo, foto de portada y productos.
 */
router.get('/public/catalogo/:slugOrCode', async (req, res) => {
  try {
    const { slugOrCode } = req.params;
    const { search, categoria, minPrecio, maxPrecio, inStock, sortBy, sortOrder } = req.query;

    if (SupabaseCatalogStore.isAvailable) {
      const clients = await SupabaseCatalogStore.getAllClients();
      const sbClient = clients.find(
        (c) => c.slug && c.slug.toLowerCase() === slugOrCode.trim().toLowerCase() && c.activo !== 0
      );
      if (sbClient) {
        const products = await SupabaseCatalogStore.getAllProducts({
          cliente_id: sbClient.id,
          search,
          categoria,
          minPrecio,
          maxPrecio,
          inStock,
          sortBy,
          sortOrder
        });
        const categories = await SupabaseCatalogStore.getCategories(sbClient.id);
        return res.json({
          success: true,
          cliente: sbClient,
          categorias: categories,
          total_productos: products.length,
          productos: products
        });
      }
    }

    const client = ClienteService.getBySlugOrCode(slugOrCode);
    if (!client) {
      return res.status(404).json({
        success: false,
        error: `El catálogo '${slugOrCode}' no fue encontrado o no está activo.`
      });
    }

    const products = ProductService.getAll({
      cliente_id: client.id,
      search,
      categoria,
      minPrecio,
      maxPrecio,
      inStock,
      sortBy,
      sortOrder
    });

    const categories = ProductService.getCategories(client.id);

    return res.json({
      success: true,
      cliente: client,
      categorias: categories,
      total_productos: products.length,
      productos: products
    });
  } catch (error) {
    console.error('Error en /api/public/catalogo:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================
// RUTAS PRIVADAS / SUPER-ADMINISTRADOR
// ====================================================

const clientUploadFields = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'portada', maxCount: 1 }
]);

/**
 * GET /api/admin/clientes
 */
router.get('/admin/clientes', authMiddleware, async (req, res) => {
  try {
    const { search } = req.query;
    const clients = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.getAllClients({ search })
      : ClienteService.getAll({ search });

    return res.json({ success: true, count: clients.length, data: clients });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/clientes/:id
 */
router.get('/admin/clientes/:id', authMiddleware, async (req, res) => {
  try {
    if (SupabaseCatalogStore.isAvailable) {
      const client = await SupabaseCatalogStore.getClientById(req.params.id);
      if (!client) {
        return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
      }
      const stats = await SupabaseCatalogStore.getStats(client.id);
      return res.json({ success: true, data: { ...client, stats } });
    }

    const client = ClienteService.getById(req.params.id);
    if (!client) {
      return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
    }
    const stats = ProductService.getStats(client.id);
    return res.json({ success: true, data: { ...client, stats } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/clientes
 * Soporta multipart (archivos para logo y portada) y JSON; persiste en Supabase
 */
router.post('/admin/clientes', authMiddleware, clientUploadFields, async (req, res) => {
  try {
    const { nombre, slug, descripcion, telefono_whatsapp, email, color_primario, moneda_simbolo, moneda_codigo } = req.body;
    let { logo_url, portada_url } = req.body;

    const folderHint = SupabaseCatalogStore.generateSlug(slug || nombre || 'tiendas');

    if (req.files) {
      if (req.files.logo && req.files.logo[0]) {
        logo_url = await SupabaseCatalogStore.uploadMulterFile(req.files.logo[0], folderHint);
      }
      if (req.files.portada && req.files.portada[0]) {
        portada_url = await SupabaseCatalogStore.uploadMulterFile(req.files.portada[0], folderHint);
      }
    }

    const newClient = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.createClient({
          nombre,
          slug,
          descripcion,
          telefono_whatsapp,
          email,
          logo_url,
          portada_url,
          color_primario,
          moneda_simbolo,
          moneda_codigo
        })
      : ClienteService.create({
          nombre,
          slug,
          descripcion,
          telefono_whatsapp,
          email,
          logo_url,
          portada_url,
          color_primario,
          moneda_simbolo,
          moneda_codigo
        });

    return res.status(201).json({
      success: true,
      message: 'Cliente y catálogo independiente generados exitosamente.',
      data: newClient
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/admin/clientes/:id
 * Actualiza datos, logotipo, portada y moneda del cliente en Supabase
 */
router.put('/admin/clientes/:id', authMiddleware, clientUploadFields, async (req, res) => {
  try {
    const { nombre, slug, descripcion, telefono_whatsapp, email, color_primario, moneda_simbolo, moneda_codigo, activo } = req.body;
    let { logo_url, portada_url } = req.body;

    const folderHint = SupabaseCatalogStore.generateSlug(slug || nombre || 'tiendas');

    if (req.files) {
      if (req.files.logo && req.files.logo[0]) {
        logo_url = await SupabaseCatalogStore.uploadMulterFile(req.files.logo[0], folderHint);
      }
      if (req.files.portada && req.files.portada[0]) {
        portada_url = await SupabaseCatalogStore.uploadMulterFile(req.files.portada[0], folderHint);
      }
    }

    const updated = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.updateClient(req.params.id, {
          nombre,
          slug,
          descripcion,
          telefono_whatsapp,
          email,
          logo_url,
          portada_url,
          color_primario,
          moneda_simbolo,
          moneda_codigo,
          activo
        })
      : ClienteService.update(req.params.id, {
          nombre,
          slug,
          descripcion,
          telefono_whatsapp,
          email,
          logo_url,
          portada_url,
          color_primario,
          moneda_simbolo,
          moneda_codigo,
          activo
        });

    return res.json({
      success: true,
      message: 'Cliente y personalización de catálogo actualizados exitosamente.',
      data: updated
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/admin/clientes/:id
 */
router.delete('/admin/clientes/:id', authMiddleware, async (req, res) => {
  try {
    const result = SupabaseCatalogStore.isAvailable
      ? await SupabaseCatalogStore.deleteClient(req.params.id)
      : ClienteService.delete(req.params.id);

    return res.json({
      success: true,
      message: 'Cliente y catálogo eliminados con éxito.',
      data: result.deleted
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

// ====================================================
// RUTAS DE INTEGRACIÓN CON SUPABASE
// ====================================================

const handleRegisterSupabaseCliente = async (req, res) => {
  try {
    const { nombre } = req.body;
    const telefono = req.body.telefono || req.body['teléfono'] || req.body.telefono_whatsapp || null;
    let logo = req.body.logo || req.body.logo_url || null;

    if (req.file) {
      logo = await SupabaseCatalogStore.uploadMulterFile(req.file, 'tiendas');
    }

    if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
      return res.status(400).json({
        success: false,
        error: 'El campo "nombre" es obligatorio para registrar el cliente.'
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        error: 'El cliente supabaseAdmin no está disponible. Verifique SUPABASE_SERVICE_ROLE_KEY en .env.'
      });
    }

    const slug = req.body.slug && req.body.slug.trim()
      ? SupabaseCatalogStore.generateSlug(req.body.slug)
      : SupabaseCatalogStore.generateSlug(nombre);

    const recordToInsert = {
      nombre: nombre.trim(),
      slug,
      telefono_whatsapp: telefono ? String(telefono).trim() : null,
      logo_url: logo ? String(logo).trim() : null
    };

    const { data, error } = await supabaseAdmin
      .from('clientes')
      .insert([recordToInsert])
      .select();

    if (error) {
      console.error('Error insertando cliente en Supabase:', error);

      if (error.code === '23505') {
        return res.status(409).json({
          success: false,
          error: `Ya existe un cliente registrado con el slug '${slug}'. Por favor use un nombre diferente.`,
          code: error.code
        });
      }

      return res.status(500).json({
        success: false,
        error: error.message || 'Error al insertar registro en Supabase.',
        details: error
      });
    }

    const created = data && data[0] ? await SupabaseCatalogStore.enrichClient(data[0]) : recordToInsert;

    return res.status(201).json({
      success: true,
      message: 'Cliente registrado exitosamente en Supabase.',
      data: created
    });
  } catch (err) {
    console.error('Excepción al registrar cliente en Supabase:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del servidor al procesar la solicitud.'
    });
  }
};

router.post('/clientes', authMiddleware, upload.single('logo'), handleRegisterSupabaseCliente);
router.post('/supabase/clientes', authMiddleware, upload.single('logo'), handleRegisterSupabaseCliente);

/**
 * GET /api/clientes (soporta filtro ?slug=...) y GET /api/clientes/:slugOrId
 */
const handleGetClientes = async (req, res) => {
  try {
    const dbClient = supabaseAdmin || supabase;
    const slugParam = (req.params.slugOrId || req.query.slug || '').toString().trim();

    if (slugParam) {
      if (dbClient) {
        const isNumeric = /^\d+$/.test(slugParam);
        const query = dbClient.from('clientes').select('*');
        const { data: sbClient, error: sbError } = isNumeric
          ? await query.eq('id', Number(slugParam)).maybeSingle()
          : await query.eq('slug', slugParam).maybeSingle();

        if (!sbError && sbClient) {
          const enriched = await SupabaseCatalogStore.enrichClient(sbClient);
          if (enriched.activo === 0) {
            return res.status(404).json({
              success: false,
              error: `El catálogo '${slugParam}' se encuentra pausado temporalmente.`
            });
          }
          return res.status(200).json({
            success: true,
            source: 'supabase',
            data: enriched
          });
        }
      }

      const localClient = /^\d+$/.test(slugParam)
        ? ClienteService.getById(Number(slugParam))
        : ClienteService.getBySlugOrCode(slugParam);

      if (localClient) {
        return res.status(200).json({
          success: true,
          source: 'local',
          data: localClient
        });
      }

      return res.status(404).json({
        success: false,
        error: `El catálogo '${slugParam}' no fue encontrado o no está activo.`
      });
    }

    if (!dbClient) {
      return res.status(500).json({
        success: false,
        error: 'Cliente de Supabase no inicializado.'
      });
    }

    const { data, error } = await dbClient
      .from('clientes')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Error al obtener clientes desde Supabase.'
      });
    }

    const meta = await SupabaseCatalogStore._loadMeta();
    const normalizedList = (data || []).map((c) => SupabaseCatalogStore.enrichClientRecord(c, meta.clients));

    return res.status(200).json({
      success: true,
      count: normalizedList.length,
      data: normalizedList
    });
  } catch (err) {
    console.error('Error en GET /api/clientes:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno al consultar clientes.'
    });
  }
};

router.get('/clientes', handleGetClientes);
router.get('/clientes/:slugOrId', handleGetClientes);
router.get('/supabase/clientes', handleGetClientes);

module.exports = router;
