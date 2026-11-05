const express = require('express');
const router = express.Router();
const ProductService = require('../services/productService');
const ClienteService = require('../services/clienteService');
const authMiddleware = require('../middleware/auth');

/**
 * GET /api/admin/stats
 * Panel de métricas e indicadores de rendimiento del inventario.
 * Soporta filtrado por 'cliente_id' para métricas de un catálogo específico o global.
 */
router.get('/admin/stats', authMiddleware, (req, res) => {
  try {
    const { cliente_id } = req.query;
    const stats = ProductService.getStats(cliente_id);
    const clients = ClienteService.getAll();

    return res.json({
      success: true,
      data: {
        ...stats,
        total_clientes: clients.length,
        clientes_activos: clients.filter(c => c.activo === 1).length
      }
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
