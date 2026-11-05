const express = require('express');
const router = express.Router();
const config = require('../config/config');
const { supabase, supabaseAdmin, envValidation } = require('../lib/supabaseClient');

/**
 * Controlador de Health Check para monitoreo en producción (Render, Railway, UptimeRobot, etc.)
 * Verifica estado del proceso Node.js y realiza una consulta ligera a Supabase.
 */
const handleHealthCheck = async (req, res) => {
  const timestamp = new Date().toISOString();
  const dbClient = supabaseAdmin || supabase;

  if (!dbClient) {
    return res.status(503).json({
      status: 'error',
      timestamp,
      uptime_seconds: Math.round(process.uptime()),
      environment: config.NODE_ENV,
      supabase: {
        status: 'misconfigured',
        connected: false,
        missing_env: envValidation?.missing || []
      }
    });
  }

  const start = Date.now();
  try {
    // Consulta ligera y rápida a Supabase para confirmar conectividad activa
    const { error } = await dbClient
      .from('clientes')
      .select('id')
      .limit(1);

    const latencyMs = Date.now() - start;

    if (error) {
      return res.status(503).json({
        status: 'error',
        timestamp,
        uptime_seconds: Math.round(process.uptime()),
        environment: config.NODE_ENV,
        supabase: {
          status: 'disconnected',
          connected: false,
          latency_ms: latencyMs,
          error: error.message
        }
      });
    }

    return res.status(200).json({
      status: 'ok',
      timestamp,
      uptime_seconds: Math.round(process.uptime()),
      environment: config.NODE_ENV,
      supabase: {
        status: 'ok',
        connected: true,
        latency_ms: latencyMs
      }
    });
  } catch (err) {
    return res.status(503).json({
      status: 'error',
      timestamp,
      uptime_seconds: Math.round(process.uptime()),
      environment: config.NODE_ENV,
      supabase: {
        status: 'disconnected',
        connected: false,
        latency_ms: Date.now() - start,
        error: err.message || 'Fallo de red al conectar con Supabase.'
      }
    });
  }
};

router.get('/health', handleHealthCheck);
router.get('/api/health', handleHealthCheck);

module.exports = router;
