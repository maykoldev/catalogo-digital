const express = require('express');
const router = express.Router();
const ClienteService = require('../services/clienteService');
const ProductService = require('../services/productService');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload');
const { supabase, supabaseAdmin } = require('../lib/supabaseClient');

/**
 * Normaliza un registro de cliente proveniente de Supabase con valores predeterminados visuales
 */
function normalizeSupabaseClient(c) {
  if (!c) return null;
  return {
    ...c,
    descripcion: c.descripcion || 'Explora nuestra colección con disponibilidad y pedidos directos por WhatsApp.',
    portada_url: c.portada_url || '',
    color_primario: c.color_primario || '#4f46e5',
    moneda_simbolo: c.moneda_simbolo || '$',
    moneda_codigo: c.moneda_codigo || 'USD',
    activo: c.activo !== undefined ? c.activo : 1,
    enlace_publico: `/c/${c.slug}`
  };
}

// ==========================================
// RUTAS PÚBLICAS (Sin Autenticación)
// ==========================================

/**
 * GET /api/public/catalogo/:slugOrCode
 * Devuelve la información del catálogo estático de un cliente, su logotipo, foto de portada y productos.
 */
router.get('/public/catalogo/:slugOrCode', (req, res) => {
  try {
    const { slugOrCode } = req.params;
    const client = ClienteService.getBySlugOrCode(slugOrCode);

    if (!client) {
      return res.status(404).json({
        success: false,
        error: `El catálogo '${slugOrCode}' no fue encontrado o no está activo.`
      });
    }

    const { search, categoria, minPrecio, maxPrecio, inStock, sortBy, sortOrder } = req.query;

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
router.get('/admin/clientes', authMiddleware, (req, res) => {
  try {
    const { search } = req.query;
    const clients = ClienteService.getAll({ search });
    return res.json({ success: true, count: clients.length, data: clients });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/clientes/:id
 */
router.get('/admin/clientes/:id', authMiddleware, (req, res) => {
  try {
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
 * Soporta multipart (archivos para logo y portada) y JSON
 */
router.post('/admin/clientes', authMiddleware, clientUploadFields, (req, res) => {
  try {
    const { nombre, slug, descripcion, telefono_whatsapp, email, color_primario, moneda_simbolo, moneda_codigo } = req.body;
    let { logo_url, portada_url } = req.body;

    if (req.files) {
      if (req.files.logo && req.files.logo[0]) {
        logo_url = `/productos/${encodeURIComponent(req.files.logo[0].filename)}`;
      }
      if (req.files.portada && req.files.portada[0]) {
        portada_url = `/productos/${encodeURIComponent(req.files.portada[0].filename)}`;
      }
    }

    const newClient = ClienteService.create({
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
 * Actualiza datos, logotipo, portada y moneda del cliente
 */
router.put('/admin/clientes/:id', authMiddleware, clientUploadFields, (req, res) => {
  try {
    const { nombre, slug, descripcion, telefono_whatsapp, email, color_primario, moneda_simbolo, moneda_codigo, activo } = req.body;
    let { logo_url, portada_url } = req.body;

    if (req.files) {
      if (req.files.logo && req.files.logo[0]) {
        logo_url = `/productos/${encodeURIComponent(req.files.logo[0].filename)}`;
      }
      if (req.files.portada && req.files.portada[0]) {
        portada_url = `/productos/${encodeURIComponent(req.files.portada[0].filename)}`;
      }
    }

    const updated = ClienteService.update(req.params.id, {
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
router.delete('/admin/clientes/:id', authMiddleware, (req, res) => {
  try {
    const result = ClienteService.delete(req.params.id);
    return res.json({
      success: true,
      message: 'Cliente y catálogo eliminados con éxito.',
      data: result.deleted
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * Función auxiliar para generar slugs URL-friendly a partir del nombre
 */
function generateSlug(text) {
  if (!text) return `cliente-${Date.now()}`;
  const slug = text
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Eliminar acentos y marcas diacríticas
    .replace(/[^a-z0-9 -]/g, '')     // Eliminar caracteres especiales no alfanuméricos
    .replace(/\s+/g, '-')            // Reemplazar espacios por guiones
    .replace(/-+/g, '-');            // Eliminar guiones consecutivos
  return slug || `cliente-${Date.now()}`;
}

// ====================================================
// RUTAS DE INTEGRACIÓN CON SUPABASE
// ====================================================

/**
 * POST /api/clientes (y /api/supabase/clientes)
 * Endpoint para registrar nuevos clientes en Supabase.
 * Recibe: nombre, teléfono (o telefono_whatsapp), logo (o logo_url o archivo multipart).
 * Genera el slug automáticamente y usa supabaseAdmin para la inserción en la tabla 'clientes'.
 */
const handleRegisterSupabaseCliente = async (req, res) => {
  try {
    const { nombre } = req.body;
    const telefono = req.body.telefono || req.body['teléfono'] || req.body.telefono_whatsapp || null;
    let logo = req.body.logo || req.body.logo_url || null;

    // Si se adjuntó un archivo de logo mediante multipart/form-data
    if (req.file) {
      logo = `/productos/${encodeURIComponent(req.file.filename)}`;
    }

    // Validación de campo requerido
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

    // Generar el slug automáticamente a partir del nombre (o respetar el enviado si existe)
    const slug = req.body.slug && req.body.slug.trim()
      ? generateSlug(req.body.slug)
      : generateSlug(nombre);

    const recordToInsert = {
      nombre: nombre.trim(),
      slug,
      telefono_whatsapp: telefono ? String(telefono).trim() : null,
      logo_url: logo ? String(logo).trim() : null
    };

    // Inserción en la tabla 'clientes' de Supabase mediante supabaseAdmin
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .insert([recordToInsert])
      .select();

    if (error) {
      console.error('Error insertando cliente en Supabase:', error);

      // Violación de restricción de unicidad en slug (código Postgres 23505)
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

    return res.status(201).json({
      success: true,
      message: 'Cliente registrado exitosamente en Supabase.',
      data: data && data[0] ? data[0] : recordToInsert
    });
  } catch (err) {
    console.error('Excepción al registrar cliente en Supabase:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del servidor al procesar la solicitud.'
    });
  }
};

router.post('/clientes', upload.single('logo'), handleRegisterSupabaseCliente);
router.post('/supabase/clientes', upload.single('logo'), handleRegisterSupabaseCliente);

/**
 * GET /api/clientes (soporta filtro ?slug=...) y GET /api/clientes/:slugOrId
 * Obtiene información pública de comercios desde Supabase (con respaldo transparente a demos locales).
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
          return res.status(200).json({
            success: true,
            source: 'supabase',
            data: normalizeSupabaseClient(sbClient)
          });
        }
      }

      // Respaldo a catálogos demostrativos locales si existe en SQLite
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

    // Listado general de clientes en Supabase
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

    const normalizedList = (data || []).map(normalizeSupabaseClient);
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
