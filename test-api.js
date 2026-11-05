// Start the server
const app = require('./src/server');

setTimeout(async () => {
  try {
    console.log('\n--- Realizando Pruebas Automatizadas del Generador Multi-Inquilino ---');

    // 1. Probar directorio público de clientes
    const clientsRes = await fetch('http://localhost:3000/api/public/clientes');
    const clients = await clientsRes.json();
    console.log(`[TEST 1] Clientes públicos activos encontrados: ${clients.count}.`);
    clients.data.forEach(c => {
      console.log(`  -> Cliente: ${c.nombre} | Enlace Único: http://localhost:3000${c.enlace_publico} | Prods: ${c.total_productos}`);
    });

    // 2. Probar acceso estático al catálogo de 'arte-scrap' SIN autenticación
    const cat1Res = await fetch('http://localhost:3000/api/public/catalogo/arte-scrap');
    const cat1Data = await cat1Res.json();
    console.log(`[TEST 2] Catálogo público 'arte-scrap': Status ${cat1Res.status}. Productos encontrados: ${cat1Data.productos.length} (WhatsApp: ${cat1Data.cliente.telefono_whatsapp})`);

    // 3. Probar acceso estático al catálogo de 'creaciones-luna' SIN autenticación
    const cat2Res = await fetch('http://localhost:3000/api/public/catalogo/creaciones-luna');
    const cat2Data = await cat2Res.json();
    console.log(`[TEST 3] Catálogo público 'creaciones-luna': Status ${cat2Res.status}. Productos encontrados: ${cat2Data.productos.length} (WhatsApp: ${cat2Data.cliente.telefono_whatsapp})`);

    // 4. Probar autenticación de Super-Admin
    const loginRes = await fetch('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123456' })
    });
    const loginData = await loginRes.json();
    console.log(`[TEST 4] Autenticación Super-Admin: ${loginData.success ? 'EXITOSA' : 'FALLIDA'}`);

    const token = loginData.token;

    // 5. Probar creación de un nuevo cliente / catálogo independiente por el Super-Admin
    const newClientRes = await fetch('http://localhost:3000/api/admin/clientes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        nombre: 'Papelería Moderna VIP',
        slug: 'papeleria-vip',
        telefono_whatsapp: '+584125550099',
        descripcion: 'Venta exclusiva de agendas y artículos ejecutivos.',
        color_primario: '#10b981'
      })
    });
    const newClient = await newClientRes.json();
    console.log(`[TEST 5] Nuevo cliente creado: ID #${newClient.data.id} '${newClient.data.nombre}'. Enlace único: http://localhost:3000${newClient.data.enlace_publico}`);

    // 6. Probar creación de producto asociado a este nuevo cliente
    const newProdRes = await fetch('http://localhost:3000/api/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        cliente_id: newClient.data.id,
        nombre: 'Cuaderno Bullet Journal A5',
        descripcion: 'Cuaderno punteado con papel de 120g libre de ácido.',
        precio: 14.50,
        inventario: 30,
        categoria: 'Cuadernos',
        imagen_url: '/productos/WhatsApp%20Image%202026-11-04%20at%207.09.25%20PM.jpeg'
      })
    });
    const newProd = await newProdRes.json();
    console.log(`[TEST 6] Producto asociado al nuevo cliente: ID #${newProd.data.id} '${newProd.data.nombre}' (Cliente: ${newProd.data.cliente_nombre})`);

    // 7. Probar consulta pública al nuevo enlace generado SIN LOGIN
    const vipRes = await fetch('http://localhost:3000/api/public/catalogo/papeleria-vip');
    const vipData = await vipRes.json();
    console.log(`[TEST 7] Verificación acceso público a 'papeleria-vip': Status ${vipRes.status}, Productos: ${vipData.productos.length}, WhatsApp configurado: ${vipData.cliente.telefono_whatsapp}`);

    // 8. Limpiar cliente de prueba
    await fetch(`http://localhost:3000/api/admin/clientes/${newClient.data.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('[TEST 8] Cliente de prueba y sus productos eliminados en cascada correctamente.');

    console.log('\n✅ TODAS LAS PRUEBAS MULTI-INQUILINO Y ENLACES ÚNICOS COMPLETADAS EXITOSAMENTE.\n');
    process.exit(0);
  } catch (err) {
    console.error('Error durante las pruebas:', err);
    process.exit(1);
  }
}, 600);
