const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

// Cargar variables de entorno desde .env si existe localmente (compatible con Node >= 18.0.0)
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

/**
 * Verifica que las variables críticas de Supabase estén definidas al arrancar.
 * Si falta alguna, muestra un error claro en consola indicando exactamente cuál falta.
 */
function validateSupabaseEnv() {
  const requiredVars = [
    {
      name: 'SUPABASE_URL',
      value: process.env.SUPABASE_URL
    },
    {
      name: 'SUPABASE_ANON_KEY',
      value: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
    },
    {
      name: 'SUPABASE_SERVICE_ROLE_KEY',
      value: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
    }
  ];

  const missing = requiredVars
    .filter(item => !item.value || String(item.value).trim() === '')
    .map(item => item.name);

  if (missing.length > 0) {
    console.error('================================================================');
    console.error('❌ [ERROR DE CONFIGURACIÓN - SUPABASE] Faltan variables de entorno críticas:');
    missing.forEach(varName => {
      console.error(`   • Falta definir: ${varName}`);
    });
    console.error('   Configure estas variables en su proveedor de despliegue o archivo .env.');
    console.error('================================================================');
    return { valid: false, missing };
  }

  return { valid: true, missing: [] };
}

// Ejecutar validación al inicializar el módulo
const envValidation = validateSupabaseEnv();

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();

// Cliente público estándar (respeta Row Level Security / RLS)
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

// Cliente administrativo con clave secreta (para operaciones backend privilegiadas)
const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

const exported = supabase || {};
exported.supabase = supabase;
exported.supabaseAdmin = supabaseAdmin;
exported.createClient = createClient;
exported.validateSupabaseEnv = validateSupabaseEnv;
exported.envValidation = envValidation;
exported.default = supabase;

module.exports = exported;
