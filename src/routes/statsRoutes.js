const express = require('express');
const router = express.Router();
const ProductService = require('../services/productService');
const ClienteService = require('../services/clienteService');
const SupabaseCatalogStore = require('../services/supabaseCatalogStore');
const authMiddleware = require('../middleware/auth');

/**
 * GET /api/admin/stats
 * Panel de métricas e indicadores de rendimiento del inventario desde Supabase.
 */
router.get('/admin/stats', authMiddleware, async (req, res) => {
  try {
    const { cliente_id } = req.query;

    if (SupabaseCatalogStore.isAvailable) {
      const [stats, clients] = await Promise.all([
        SupabaseCatalogStore.getStats(cliente_id),
        SupabaseCatalogStore.getAllClients()
      ]);

      return res.json({
        success: true,
        data: {
          ...stats,
          total_clientes: clients.length,
          clientes_activos: clients.filter((c) => c.activo !== 0).length
        }
      });
    }

    const stats = ProductService.getStats(cliente_id);
    const clients = ClienteService.getAll();

    return res.json({
      success: true,
      data: {
        ...stats,
        total_clientes: clients.length,
        clientes_activos: clients.filter((c) => c.activo === 1).length
      }
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
