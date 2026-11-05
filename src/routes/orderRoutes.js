const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const ClienteService = require('../services/clienteService');

/**
 * Función auxiliar para limpiar y formatear números de teléfono a dígitos internacionales para WhatsApp
 */
function cleanWhatsAppNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  return digits.length >= 7 ? digits : null;
}

/**
 * Controlador de procesamiento de carrito y generación de mensaje WhatsApp
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

    // 2. Validar que el comercio exista en Supabase y obtener su número de WhatsApp
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

      clientData = sbClient;
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

    // Opcional: Obtener detalles reales de productos en Supabase si se enviaron IDs
    const productIds = items
      .map(item => item.producto_id || item.id)
      .filter(id => id && !isNaN(Number(id)))
      .map(id => Number(id));

    const productsMap = new Map();
    if (productIds.length > 0 && supabaseAdmin && req.body.source !== 'local') {
      const { data: dbProducts } = await supabaseAdmin
        .from('productos')
        .select('id, nombre, precio')
        .in('id', productIds);

      if (dbProducts) {
        dbProducts.forEach(p => productsMap.set(p.id, p));
      }
    }

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

      const subtotal = parseFloat((cantidad * precioUnitario).toFixed(2));
      total += subtotal;

      processedItems.push({
        producto_id: prodId ? Number(prodId) : null,
        nombre: String(nombre).trim(),
        cantidad,
        precio_unitario: precioUnitario,
        subtotal
      });
    }

    total = parseFloat(total.toFixed(2));

    const currencySymbol = clientData.moneda_simbolo || '$';
    const currencyCode = clientData.moneda_codigo || 'USD';

    // 4. Construir el mensaje estructurado y limpio para WhatsApp
    let message = `🛒 *NUEVO PEDIDO DIGITAL*\n`;
    message += `🏪 *Comercio:* ${clientData.nombre}\n\n`;

    message += `👤 *DATOS DEL COMPRADOR:*\n`;
    message += `• *Nombre:* ${compradorNombre.trim()}\n`;
    message += `• *Teléfono:* ${String(compradorTelefono).trim()}\n`;
    if (direccionEntrega && direccionEntrega.trim()) {
      message += `• *Dirección de Entrega:* ${direccionEntrega.trim()}\n`;
    }
    message += `\n📦 *DETALLE DE PRODUCTOS:*\n`;

    processedItems.forEach((it, index) => {
      message += `${index + 1}. *${it.nombre}*\n`;
      message += `   - Cantidad: ${it.cantidad} unid.\n`;
      message += `   - Precio unit.: ${currencySymbol}${it.precio_unitario.toFixed(2)}\n`;
      message += `   - Subtotal: ${currencySymbol}${it.subtotal.toFixed(2)}\n`;
    });

    message += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💰 *TOTAL GENERAL:* ${currencySymbol}${total.toFixed(2)} ${currencyCode}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `¡Hola! Me gustaría confirmar este pedido realizado desde su catálogo digital. ¿Podrían indicarme los métodos de pago y tiempo de entrega?`;

    // 5. Codificar para URL y construir enlace de WhatsApp
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/${cleanWhatsApp}?text=${encodedMessage}`;

    // 6. Respuesta JSON exitosa
    return res.status(200).json({
      success: true,
      message: 'Pedido procesado exitosamente y enlace de WhatsApp generado.',
      pedido: {
        cliente: {
          id: clientData.id,
          nombre: clientData.nombre,
          slug: clientData.slug,
          telefono_whatsapp: cleanWhatsApp
        },
        comprador: {
          nombre: compradorNombre.trim(),
          telefono: String(compradorTelefono).trim(),
          direccion_entrega: direccionEntrega && direccionEntrega.trim() ? direccionEntrega.trim() : null
        },
        items: processedItems,
        total_articulos: processedItems.reduce((acc, it) => acc + it.cantidad, 0),
        total,
        moneda_simbolo: currencySymbol,
        moneda_codigo: currencyCode
      },
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

router.post('/pedidos', handleProcessOrder);
router.post('/checkout', handleProcessOrder);

module.exports = router;
