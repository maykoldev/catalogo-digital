const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/config');
const { supabaseAdmin } = require('../lib/supabaseClient');
const ClienteService = require('../services/clienteService');
const SupabaseCatalogStore = require('../services/supabaseCatalogStore');

const CONFIG_BUCKET = 'catalogo-config';
const ORDERS_FOLDER = 'pedidos';
const LOCAL_ORDERS_DIR = path.join(config.DATA_DIR || path.join(config.ROOT_DIR, 'data'), 'pedidos');
const ordersMemoryCache = new Map();

/**
 * Escapa texto HTML para prevenir XSS en la vista visual del pedido
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Función auxiliar para limpiar y formatear números de teléfono a dígitos internacionales para WhatsApp
 */
function cleanWhatsAppNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  return digits.length >= 7 ? digits : null;
}

/**
 * Obtiene la URL base pública del servidor a partir de la petición HTTP (compatible con Render/Cloudflare)
 */
function resolveBaseUrl(req) {
  const publicEnv = (process.env.PUBLIC_API_URL || '').trim().replace(/\/$/, '');
  if (publicEnv && /^https?:\/\//i.test(publicEnv)) {
    return publicEnv;
  }
  const protoHeader = req.headers['x-forwarded-proto'];
  const protocol = protoHeader ? String(protoHeader).split(',')[0].trim() : (req.protocol || 'http');
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${config.PORT || 3000}`;
  return `${protocol}://${host}`;
}

/**
 * Genera un código corto y único para el enlace del pedido (ej. "a7f9k2m4")
 */
function generateOrderCode() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Guarda los datos del pedido en memoria, disco local y Supabase Storage para persistencia permanente
 */
async function saveVisualOrder(orderData) {
  if (!orderData || !orderData.id) return;
  const cleanId = String(orderData.id).replace(/[^a-zA-Z0-9_-]/g, '');
  ordersMemoryCache.set(cleanId, orderData);

  // 1. Respaldo en disco local
  try {
    if (!fs.existsSync(LOCAL_ORDERS_DIR)) {
      fs.mkdirSync(LOCAL_ORDERS_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(LOCAL_ORDERS_DIR, `${cleanId}.json`),
      JSON.stringify(orderData, null, 2),
      'utf8'
    );
  } catch (_) {}

  // 2. Persistencia en Supabase Storage (sobrevive reinicios del servidor en Render/Railway)
  if (supabaseAdmin) {
    try {
      await SupabaseCatalogStore._ensureConfigBucket();
      const payload = Buffer.from(JSON.stringify(orderData, null, 2), 'utf8');
      await supabaseAdmin.storage
        .from(CONFIG_BUCKET)
        .upload(`${ORDERS_FOLDER}/${cleanId}.json`, payload, {
          upsert: true,
          contentType: 'application/json'
        });
    } catch (err) {
      console.error('[orderRoutes] Error guardando pedido visual en Supabase Storage:', err.message);
    }
  }
}

/**
 * Recupera un pedido guardado por su código único desde memoria, disco o Supabase Storage
 */
async function getVisualOrderById(rawId) {
  const cleanId = String(rawId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  if (!cleanId) return null;

  if (ordersMemoryCache.has(cleanId)) {
    return ordersMemoryCache.get(cleanId);
  }

  // Intentar desde disco local
  try {
    const localPath = path.join(LOCAL_ORDERS_DIR, `${cleanId}.json`);
    if (fs.existsSync(localPath)) {
      const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      ordersMemoryCache.set(cleanId, parsed);
      return parsed;
    }
  } catch (_) {}

  // Intentar desde Supabase Storage
  if (supabaseAdmin) {
    try {
      await SupabaseCatalogStore._ensureConfigBucket();
      const { data, error } = await supabaseAdmin.storage
        .from(CONFIG_BUCKET)
        .download(`${ORDERS_FOLDER}/${cleanId}.json`);
      if (!error && data) {
        const text = await data.text();
        const parsed = JSON.parse(text);
        ordersMemoryCache.set(cleanId, parsed);
        return parsed;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Controlador de procesamiento de carrito y generación de mensaje WhatsApp con enlace visual único
 * POST /api/pedidos y POST /api/checkout
 */
const handleProcessOrder = async (req, res) => {
  try {
    const { cliente_id, items } = req.body;

    // Extracción flexible de datos del comprador (soporta objeto anidado o campos planos)
    const compradorNombre = req.body.comprador?.nombre || req.body.nombre_comprador || req.body.nombre || null;
    const compradorTelefono = req.body.comprador?.telefono || req.body.telefono_comprador || req.body.telefono || null;
    const direccionEntrega = req.body.comprador?.direccion || req.body.direccion_entrega || req.body.direccion || null;

    // 1. Validaciones básicas de entrada
    if (!cliente_id || isNaN(Number(cliente_id)) || !Number.isInteger(Number(cliente_id)) || Number(cliente_id) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El campo "cliente_id" es obligatorio y debe ser un número entero positivo.'
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'El carrito de compras debe contener al menos un producto en el array "items".'
      });
    }

    if (!compradorNombre || typeof compradorNombre !== 'string' || !compradorNombre.trim()) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del cliente/comprador es obligatorio.'
      });
    }

    if (!compradorTelefono || !String(compradorTelefono).trim()) {
      return res.status(400).json({
        success: false,
        error: 'El teléfono de contacto del cliente/comprador es obligatorio.'
      });
    }

    const parsedClienteId = parseInt(cliente_id, 10);
    let clientData = null;

    // Si proviene explícitamente de un catálogo demostrativo local (source === 'local')
    if (req.body.source === 'local' && req.body.cliente_slug) {
      clientData = ClienteService.getBySlugOrCode(req.body.cliente_slug);
    }

    // 2. Validar que el comercio exista en Supabase y obtener su configuración enriquecida
    if (!clientData) {
      if (!supabaseAdmin) {
        return res.status(500).json({
          success: false,
          error: 'El cliente supabaseAdmin no está disponible. Verifique las variables de entorno de Supabase.'
        });
      }

      const { data: sbClient, error: clientError } = await supabaseAdmin
        .from('clientes')
        .select('*')
        .eq('id', parsedClienteId)
        .maybeSingle();

      if (clientError) {
        console.error(`Error al consultar cliente ${parsedClienteId} en Supabase:`, clientError);
        return res.status(500).json({
          success: false,
          error: 'Error al verificar el comercio en la base de datos de Supabase.',
          details: clientError.message
        });
      }

      clientData = sbClient ? await SupabaseCatalogStore.enrichClient(sbClient) : null;
    }

    if (!clientData) {
      return res.status(404).json({
        success: false,
        error: `El comercio con cliente_id ${parsedClienteId} no fue encontrado en la base de datos de Supabase.`
      });
    }

    const cleanWhatsApp = cleanWhatsAppNumber(clientData.telefono_whatsapp);
    if (!cleanWhatsApp) {
      return res.status(400).json({
        success: false,
        error: `El comercio "${clientData.nombre}" no tiene registrado un número de teléfono/WhatsApp válido para recibir pedidos.`
      });
    }

    // Obtener detalles e imágenes reales de productos en Supabase si se enviaron IDs
    const productIds = items
      .map(item => item.producto_id || item.id)
      .filter(id => id && !isNaN(Number(id)))
      .map(id => Number(id));

    const productsMap = new Map();
    if (productIds.length > 0 && supabaseAdmin && req.body.source !== 'local') {
      const { data: dbProducts } = await supabaseAdmin
        .from('productos')
        .select('id, nombre, precio, imagen_url')
        .in('id', productIds);

      if (dbProducts) {
        const enrichedList = await SupabaseCatalogStore.enrichProductsList(dbProducts);
        enrichedList.forEach(p => productsMap.set(Number(p.id), p));
      }
    }

    const baseUrl = resolveBaseUrl(req);
    const defaultPlaceholder = 'https://placehold.co/400x400/e2e8f0/475569?text=Producto';

    // 3. Procesar ítems y calcular totales
    let total = 0;
    const processedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const prodId = item.producto_id || item.id;
      const dbProduct = prodId ? productsMap.get(Number(prodId)) : null;

      const nombre = item.nombre || (dbProduct ? dbProduct.nombre : `Producto #${prodId || i + 1}`);
      const cantidad = parseInt(item.cantidad || item.qty || item.quantity, 10);
      const precioUnitario = parseFloat(
        item.precio_unitario !== undefined
          ? item.precio_unitario
          : (item.precio !== undefined ? item.precio : (dbProduct ? dbProduct.precio : 0))
      );

      if (isNaN(cantidad) || cantidad <= 0) {
        return res.status(400).json({
          success: false,
          error: `La cantidad para el ítem #${i + 1} ("${nombre}") debe ser un número entero mayor a 0.`
        });
      }

      if (isNaN(precioUnitario) || precioUnitario < 0) {
        return res.status(400).json({
          success: false,
          error: `El precio unitario para el ítem #${i + 1} ("${nombre}") debe ser un número válido mayor o igual a 0.`
        });
      }

      const subtotal =
        item.subtotal !== undefined && !isNaN(Number(item.subtotal)) && Number(item.subtotal) >= 0
          ? parseFloat(Number(item.subtotal).toFixed(2))
          : parseFloat((cantidad * precioUnitario).toFixed(2));
      total += subtotal;

      let rawImg = item.imagen_url || (dbProduct ? dbProduct.imagen_url : '') || defaultPlaceholder;
      if (rawImg.startsWith('/')) {
        rawImg = `${baseUrl}${rawImg}`;
      }

      processedItems.push({
        producto_id: prodId ? Number(prodId) : null,
        nombre: String(nombre).trim(),
        cantidad,
        precio_unitario: precioUnitario,
        subtotal,
        modalidad: item.modalidad ? String(item.modalidad).trim() : '',
        imagen_url: rawImg
      });
    }

    total = parseFloat(total.toFixed(2));
    const totalArticulos = processedItems.reduce((acc, it) => acc + it.cantidad, 0);

    const currencySymbol = clientData.moneda_simbolo || '$';
    const currencyCode = clientData.moneda_codigo || 'USD';

    // 4. Crear y guardar el registro del Pedido Visual con su enlace único
    const orderId = generateOrderCode();
    const orderUrl = `${baseUrl}/pedido/${orderId}`;

    const orderRecord = {
      id: orderId,
      created_at: new Date().toISOString(),
      order_url: orderUrl,
      cliente: {
        id: clientData.id,
        nombre: clientData.nombre,
        slug: clientData.slug,
        logo_url: clientData.logo_url || '',
        color_primario: clientData.color_primario || '#4f46e5',
        telefono_whatsapp: cleanWhatsApp
      },
      comprador: {
        nombre: compradorNombre.trim(),
        telefono: String(compradorTelefono).trim(),
        direccion_entrega: direccionEntrega && direccionEntrega.trim() ? direccionEntrega.trim() : null
      },
      items: processedItems,
      total_articulos: totalArticulos,
      total,
      moneda_simbolo: currencySymbol,
      moneda_codigo: currencyCode
    };

    await saveVisualOrder(orderRecord);

    // 5. Construir el mensaje corto y directo para WhatsApp (solo enlace visual con fotos, cantidades y total)
    let message = `🛒 *PEDIDO #${orderId.toUpperCase()}*\n`;
    message += `👤 *Cliente:* ${compradorNombre.trim()} (${String(compradorTelefono).trim()})\n`;
    if (direccionEntrega && direccionEntrega.trim()) {
      message += `📍 *Dirección:* ${direccionEntrega.trim()}\n`;
    }
    message += `\n🖼️ *VER FOTOS DEL PEDIDO AQUÍ:*\n${orderUrl}\n`;
    message += `\n📦 *ARTÍCULOS (${totalArticulos}):*\n`;

    processedItems.forEach((it) => {
      message += `• *${it.cantidad}x* ${it.nombre}\n`;
    });

    message += `\n💰 *TOTAL:* ${currencySymbol}${total.toFixed(2)} ${currencyCode}`;

    // 6. Codificar para URL y construir enlace de WhatsApp
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/${cleanWhatsApp}?text=${encodedMessage}`;

    return res.status(200).json({
      success: true,
      message: 'Pedido procesado exitosamente y enlace visual generado.',
      pedido: orderRecord,
      order_url: orderUrl,
      mensaje_whatsapp: message,
      whatsapp_url: whatsappUrl
    });
  } catch (err) {
    console.error('Error al procesar pedido y generar enlace WhatsApp:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del servidor al procesar el pedido.'
    });
  }
};

/**
 * GET /api/pedidos/:id
 * Devuelve los datos JSON de un pedido visual guardado
 */
router.get('/pedidos/:id', async (req, res) => {
  try {
    const order = await getVisualOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'El pedido solicitado no existe o no fue encontrado.'
      });
    }
    return res.json({ success: true, data: order });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Renderiza la pantalla visual con las fotos grandes, cantidades y el total del pedido (/pedido/:id)
 */
const handleRenderVisualOrderPage = async (req, res) => {
  try {
    const order = await getVisualOrderById(req.params.id);
    if (!order) {
      return res.status(404).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pedido no encontrado</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body style="background:#f8fafc; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:1.5rem;">
  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:2.5rem 1.75rem; max-width:440px; text-align:center; box-shadow:0 4px 12px rgba(15,23,42,0.06);">
    <div style="font-size:3rem; margin-bottom:0.75rem;">📦</div>
    <h1 style="font-size:1.25rem; font-weight:800; color:#0f172a; margin-bottom:0.5rem;">Pedido no encontrado</h1>
    <p style="color:#64748b; font-size:0.9rem; line-height:1.5;">El enlace de este pedido no existe o ha expirado.</p>
  </div>
</body>
</html>`);
    }

    const brandColor = order.cliente?.color_primario || '#4f46e5';
    const storeName = order.cliente?.nombre || 'Catálogo Digital';
    const storeSlug = order.cliente?.slug || '';
    const storeLogo = order.cliente?.logo_url || '';
    const currencySymbol = order.moneda_simbolo || '$';
    const currencyCode = order.moneda_codigo || 'USD';
    const totalFormatted = `${currencySymbol}${Number(order.total || 0).toFixed(2)} ${currencyCode}`;
    const firstImage = (order.items && order.items[0] && order.items[0].imagen_url) || '';
    const buyerPhoneDigits = cleanWhatsAppNumber(order.comprador?.telefono);

    const dateObj = order.created_at ? new Date(order.created_at) : new Date();
    const formattedDate = dateObj.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const ogTitle = `Pedido #${String(order.id).toUpperCase()} — ${storeName}`;
    const ogDesc = `Cliente: ${order.comprador?.nombre || ''} • ${order.total_articulos} artículo(s) • Total: ${totalFormatted}`;

    const itemsCardsHtml = (order.items || [])
      .map((it, idx) => {
        const imgUrl = it.imagen_url || 'https://placehold.co/400x400/e2e8f0/475569?text=Producto';
        return `
        <article class="visual-order-card">
          <div class="visual-order-img-wrap" onclick="openLightbox('${escapeHtml(imgUrl)}', '${escapeHtml(it.nombre)}', ${Number(it.cantidad)})">
            <img
              src="${escapeHtml(imgUrl)}"
              alt="${escapeHtml(it.nombre)}"
              class="visual-order-img"
              loading="eager"
              onerror="this.onerror=null; this.src='https://placehold.co/400x400/e2e8f0/475569?text=Sin+Imagen';"
            />
            <span class="visual-order-index">#${idx + 1}</span>
            <div class="visual-order-qty-pill">
              Cantidad: <strong>${Number(it.cantidad)}</strong>
            </div>
          </div>
          <div class="visual-order-body">
            <h3 class="visual-order-title">${escapeHtml(it.nombre)}</h3>
            <div class="visual-order-qty-box">
              <span>Unidades solicitadas</span>
              <span class="visual-order-qty-number">× ${Number(it.cantidad)}</span>
            </div>
          </div>
        </article>`;
      })
      .join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(ogTitle)}</title>
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(ogDesc)}" />
  <meta property="og:type" content="website" />
  ${firstImage ? `<meta property="og:image" content="${escapeHtml(firstImage)}" />` : ''}
  <link rel="stylesheet" href="/css/styles.css" />
  <style>
    :root {
      --brand: ${escapeHtml(brandColor)};
    }
    body {
      background: #f1f5f9;
      color: #0f172a;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding-bottom: 5.5rem;
    }
    .order-topbar {
      background: linear-gradient(135deg, #0f172a 0%, var(--brand) 100%);
      color: #fff;
      padding: 1.5rem 1rem;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14);
    }
    .order-container {
      max-width: 980px;
      margin: 0 auto;
      padding: 0 1rem;
    }
    .order-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .order-store-brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }
    .order-store-logo {
      width: 54px;
      height: 54px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid #fff;
      background: #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .order-summary-strip {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 1.15rem 1.35rem;
      margin-top: -1rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .buyer-details {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem 1.5rem;
      font-size: 0.9rem;
      color: #334155;
    }
    .total-highlight-box {
      background: #f8fafc;
      border: 2px solid var(--brand);
      border-radius: 12px;
      padding: 0.65rem 1.15rem;
      text-align: right;
      min-width: 180px;
    }
    .total-highlight-label {
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
      display: block;
    }
    .total-highlight-value {
      font-size: 1.55rem;
      font-weight: 900;
      color: var(--brand);
      line-height: 1.2;
    }
    .visual-order-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 1.25rem;
    }
    .visual-order-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.05);
      display: flex;
      flex-direction: column;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .visual-order-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.1);
    }
    .visual-order-img-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 1 / 1;
      background: #f8fafc;
      overflow: hidden;
      cursor: zoom-in;
      border-bottom: 1px solid #f1f5f9;
    }
    .visual-order-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .visual-order-index {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(15, 23, 42, 0.78);
      color: #fff;
      font-size: 0.75rem;
      font-weight: 800;
      padding: 3px 9px;
      border-radius: 999px;
    }
    .visual-order-qty-pill {
      position: absolute;
      bottom: 10px;
      right: 10px;
      background: var(--brand);
      color: #fff;
      font-size: 0.95rem;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 999px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      border: 2px solid #fff;
    }
    .visual-order-qty-pill strong {
      font-size: 1.1rem;
      font-weight: 900;
    }
    .visual-order-body {
      padding: 1rem 1.15rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      flex: 1;
    }
    .visual-order-title {
      font-size: 1.05rem;
      font-weight: 800;
      color: #0f172a;
      margin: 0;
      line-height: 1.3;
    }
    .visual-order-qty-box {
      margin-top: auto;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 0.5rem 0.75rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.82rem;
      color: #475569;
      font-weight: 600;
    }
    .visual-order-qty-number {
      font-size: 1.2rem;
      font-weight: 900;
      color: var(--brand);
    }
    .sticky-bottom-total {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: #ffffff;
      border-top: 2px solid #e2e8f0;
      padding: 0.85rem 1rem;
      box-shadow: 0 -4px 16px rgba(15, 23, 42, 0.08);
      z-index: 40;
    }
    .sticky-bottom-inner {
      max-width: 980px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    /* Lightbox para ampliar imagen */
    .lightbox-overlay {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.88);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 1rem;
    }
    .lightbox-overlay.active {
      display: flex;
    }
    .lightbox-box {
      position: relative;
      max-width: 92vw;
      max-height: 90vh;
      text-align: center;
    }
    .lightbox-box img {
      max-width: 100%;
      max-height: 78vh;
      border-radius: 12px;
      object-fit: contain;
      background: #fff;
      box-shadow: 0 12px 32px rgba(0,0,0,0.4);
    }
  </style>
</head>
<body>

  <header class="order-topbar">
    <div class="order-container order-header-row">
      <div class="order-store-brand">
        ${
          storeLogo
            ? `<img src="${escapeHtml(storeLogo)}" alt="Logo" class="order-store-logo" onerror="this.style.display='none'" />`
            : `<div style="width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-size:1.5rem;">🛍️</div>`
        }
        <div>
          <div style="font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.85; font-weight: 700;">
            Resumen Visual de Pedido • #${escapeHtml(String(order.id).toUpperCase())}
          </div>
          <h1 style="font-size: 1.45rem; font-weight: 900; margin: 0.1rem 0 0 0;">${escapeHtml(storeName)}</h1>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
        <span style="background: rgba(255,255,255,0.16); padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600;">
          📅 ${escapeHtml(formattedDate)}
        </span>
        ${
          storeSlug
            ? `<a href="/c/${escapeHtml(storeSlug)}" class="btn btn-secondary btn-sm" style="background:#fff; color:#0f172a; font-weight:700; text-decoration:none;">
                ← Ver Catálogo
              </a>`
            : ''
        }
      </div>
    </div>
  </header>

  <main class="order-container">
    <section class="order-summary-strip">
      <div class="buyer-details">
        <div>
          <span style="color:#64748b; font-size:0.78rem; display:block; font-weight:700; text-transform:uppercase;">Cliente</span>
          <strong style="font-size:1rem; color:#0f172a;">👤 ${escapeHtml(order.comprador?.nombre || 'Cliente')}</strong>
        </div>
        <div>
          <span style="color:#64748b; font-size:0.78rem; display:block; font-weight:700; text-transform:uppercase;">Teléfono / WhatsApp</span>
          <strong style="font-size:1rem; color:#0f172a;">
            📞 ${
              buyerPhoneDigits
                ? `<a href="https://wa.me/${escapeHtml(buyerPhoneDigits)}" target="_blank" style="color:var(--brand); text-decoration:underline;">${escapeHtml(order.comprador?.telefono)}</a>`
                : escapeHtml(order.comprador?.telefono || '--')
            }
          </strong>
        </div>
        ${
          order.comprador?.direccion_entrega
            ? `<div>
                <span style="color:#64748b; font-size:0.78rem; display:block; font-weight:700; text-transform:uppercase;">Dirección</span>
                <strong style="font-size:0.95rem; color:#0f172a;">📍 ${escapeHtml(order.comprador.direccion_entrega)}</strong>
              </div>`
            : ''
        }
        <div>
          <span style="color:#64748b; font-size:0.78rem; display:block; font-weight:700; text-transform:uppercase;">Total Artículos</span>
          <strong style="font-size:1rem; color:#0f172a;">📦 ${Number(order.total_articulos || 0)} unidades</strong>
        </div>
      </div>

      <div class="total-highlight-box">
        <span class="total-highlight-label">Total del Pedido</span>
        <span class="total-highlight-value">${escapeHtml(totalFormatted)}</span>
      </div>
    </section>

    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <h2 style="font-size:1.15rem; font-weight:800; margin:0; color:#0f172a;">
        🖼️ Fotos y Cantidades Solicitadas (${(order.items || []).length} ${ (order.items || []).length === 1 ? 'referencia' : 'referencias' })
      </h2>
      <span style="font-size:0.8rem; color:#64748b;">Toca cualquier foto para ampliarla</span>
    </div>

    <section class="visual-order-grid">
      ${itemsCardsHtml}
    </section>
  </main>

  <div class="sticky-bottom-total">
    <div class="sticky-bottom-inner">
      <div style="font-weight: 700; color: #334155; font-size: 0.95rem;">
        📦 <strong>${Number(order.total_articulos || 0)}</strong> unidades en total
      </div>
      <div style="display: flex; align-items: center; gap: 0.65rem;">
        <span style="font-size: 0.85rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Total:</span>
        <span style="font-size: 1.45rem; font-weight: 900; color: var(--brand);">${escapeHtml(totalFormatted)}</span>
      </div>
    </div>
  </div>

  <!-- Lightbox para ver foto en pantalla completa -->
  <div id="lightbox" class="lightbox-overlay" onclick="closeLightbox()">
    <div class="lightbox-box" onclick="event.stopPropagation()">
      <img id="lightbox-img" src="" alt="Vista ampliada" />
      <div id="lightbox-caption" style="color:#fff; font-weight:800; font-size:1.1rem; margin-top:0.75rem;"></div>
      <button type="button" onclick="closeLightbox()" class="btn btn-secondary btn-sm" style="margin-top:0.65rem; background:#fff; color:#0f172a; font-weight:700;">
        Cerrar vista
      </button>
    </div>
  </div>

  <script>
    function openLightbox(url, title, qty) {
      var lb = document.getElementById('lightbox');
      var img = document.getElementById('lightbox-img');
      var cap = document.getElementById('lightbox-caption');
      img.src = url;
      cap.textContent = title + ' — Cantidad: ' + qty;
      lb.classList.add('active');
    }
    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('active');
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Error al renderizar página visual del pedido:', err);
    return res.status(500).send('Error al cargar el pedido.');
  }
};

router.post('/pedidos', handleProcessOrder);
router.post('/checkout', handleProcessOrder);

module.exports = router;
module.exports.handleRenderVisualOrderPage = handleRenderVisualOrderPage;
