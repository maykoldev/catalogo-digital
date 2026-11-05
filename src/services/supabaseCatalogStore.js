const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../lib/supabaseClient');

const CONFIG_BUCKET = 'catalogo-config';
const META_FILE = 'metadata.json';
const DEFAULT_STORAGE_BUCKET = 'productos';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif']);

class SupabaseCatalogStore {
  static _bucketEnsured = false;
  static _metaCache = null;
  static _metaLoadedAt = 0;

  static get isAvailable() {
    return Boolean(supabaseAdmin);
  }

  /**
   * Genera un slug limpio y compatible con URLs
   */
  static generateSlug(text) {
    if (!text) return `catalogo-${Date.now()}`;
    const clean = text
      .toString()
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return clean || `catalogo-${Date.now()}`;
  }

  /**
   * Codifica de forma segura una URL pública de Storage (incluyendo espacios y paréntesis)
   */
  static encodePublicStorageUrl(rawUrl) {
    if (!rawUrl) return '';
    return rawUrl
      .replace(/ /g, '%20')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/'/g, '%27');
  }

  // =========================================================
  // METADATOS EXTENDIDOS EN SUPABASE (Moneda, Portada, Categoría)
  // =========================================================

  static async _ensureConfigBucket() {
    if (this._bucketEnsured || !supabaseAdmin) return;
    try {
      const { data: buckets } = await supabaseAdmin.storage.listBuckets();
      const exists = (buckets || []).some((b) => b.name === CONFIG_BUCKET);
      if (!exists) {
        await supabaseAdmin.storage.createBucket(CONFIG_BUCKET, { public: false });
      }
      this._bucketEnsured = true;
    } catch (_) {}
  }

  static async _loadMeta(force = false) {
    const now = Date.now();
    if (!force && this._metaCache && now - this._metaLoadedAt < 15000) {
      return this._metaCache;
    }

    const emptyMeta = { clients: {}, products: {} };
    if (!supabaseAdmin) return emptyMeta;

    try {
      await this._ensureConfigBucket();
      const { data, error } = await supabaseAdmin.storage.from(CONFIG_BUCKET).download(META_FILE);
      if (error || !data) {
        if (!this._metaCache) {
          this._metaCache = emptyMeta;
          this._metaLoadedAt = now;
        }
        return this._metaCache || emptyMeta;
      }

      const text = await data.text();
      const parsed = JSON.parse(text);
      this._metaCache = {
        clients: (parsed && parsed.clients) || {},
        products: (parsed && parsed.products) || {}
      };
      this._metaLoadedAt = now;
      return this._metaCache;
    } catch (_) {
      return this._metaCache || emptyMeta;
    }
  }

  static async _saveMeta(meta) {
    this._metaCache = meta;
    this._metaLoadedAt = Date.now();
    if (!supabaseAdmin) return;

    try {
      await this._ensureConfigBucket();
      const payload = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
      await supabaseAdmin.storage.from(CONFIG_BUCKET).upload(META_FILE, payload, {
        upsert: true,
        contentType: 'application/json'
      });
    } catch (err) {
      console.error('[SupabaseCatalogStore] Error guardando metadata:', err.message);
    }
  }

  static enrichClientRecord(c, metaClients = {}) {
    if (!c) return null;
    const extra = metaClients[String(c.id)] || {};
    return {
      ...c,
      descripcion:
        c.descripcion ||
        extra.descripcion ||
        'Explora nuestra colección con disponibilidad y pedidos directos por WhatsApp.',
      email: c.email || extra.email || '',
      logo_url: c.logo_url || extra.logo_url || '',
      portada_url: c.portada_url || extra.portada_url || '',
      color_primario: c.color_primario || extra.color_primario || '#4f46e5',
      moneda_simbolo: c.moneda_simbolo || extra.moneda_simbolo || '$',
      moneda_codigo: c.moneda_codigo || extra.moneda_codigo || 'USD',
      activo: c.activo !== undefined ? c.activo : extra.activo !== undefined ? extra.activo : 1,
      enlace_publico: `/c/${c.slug}`
    };
  }

  static enrichProductRecord(p, metaProducts = {}, clientsMap = new Map()) {
    if (!p) return null;
    const extra = metaProducts[String(p.id)] || {};
    const owner = clientsMap.get(Number(p.cliente_id));
    return {
      ...p,
      precio: Number(p.precio) || 0,
      inventario: p.inventario !== undefined && p.inventario !== null ? Number(p.inventario) : 0,
      descripcion: p.descripcion || '',
      categoria: p.categoria || extra.categoria || 'General',
      imagen_url: p.imagen_url || 'https://placehold.co/400x400/e2e8f0/475569?text=Producto',
      cliente_nombre: p.cliente_nombre || (owner ? owner.nombre : 'Tienda'),
      cliente_slug: p.cliente_slug || (owner ? owner.slug : '')
    };
  }

  static async enrichClient(client) {
    if (!client) return null;
    const meta = await this._loadMeta();
    return this.enrichClientRecord(client, meta.clients);
  }

  static async enrichProductsList(products) {
    const meta = await this._loadMeta();
    return (products || []).map((p) => this.enrichProductRecord(p, meta.products));
  }

  // =========================================================
  // EXPLORADOR DE SUPABASE STORAGE (CARPETAS E IMÁGENES)
  // =========================================================

  static async listStorageContents({ bucket = DEFAULT_STORAGE_BUCKET, prefix = '' } = {}) {
    if (!supabaseAdmin) {
      throw new Error('Cliente administrativo de Supabase no disponible.');
    }

    const { data: allBuckets, error: bucketsErr } = await supabaseAdmin.storage.listBuckets();
    if (bucketsErr) {
      throw new Error(`Error al consultar buckets de Storage: ${bucketsErr.message}`);
    }

    const userBuckets = (allBuckets || []).filter((b) => b.name !== CONFIG_BUCKET);
    let activeBucketObj =
      userBuckets.find((b) => b.name === bucket) ||
      userBuckets.find((b) => b.name === DEFAULT_STORAGE_BUCKET) ||
      userBuckets[0];

    const activeBucket = activeBucketObj ? activeBucketObj.name : bucket || DEFAULT_STORAGE_BUCKET;
    const isPublicBucket = activeBucketObj ? Boolean(activeBucketObj.public) : true;

    // Normalizar prefijo de carpeta evitando saltos de directorio
    const cleanPrefix = String(prefix || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('/');

    // Consultar contenido del nivel actual y también carpetas raíz para navegación rápida
    const listPromise = supabaseAdmin.storage.from(activeBucket).list(cleanPrefix, {
      limit: 500,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' }
    });

    const rootPromise =
      cleanPrefix === ''
        ? listPromise
        : supabaseAdmin.storage.from(activeBucket).list('', {
            limit: 200,
            offset: 0,
            sortBy: { column: 'name', order: 'asc' }
          });

    const [currentRes, rootRes] = await Promise.all([listPromise, rootPromise]);

    if (currentRes.error) {
      throw new Error(`Error al listar la carpeta '${cleanPrefix || '/'}': ${currentRes.error.message}`);
    }

    const items = currentRes.data || [];
    const rootItems = (rootRes && rootRes.data) || [];

    const rootFolders = rootItems
      .filter((item) => !item.id && item.name && !item.name.startsWith('.'))
      .map((item) => ({
        name: item.name,
        path: item.name
      }));

    const folders = [];
    const rawFiles = [];

    for (const item of items) {
      if (!item || !item.name || item.name.startsWith('.')) continue;

      const itemPath = cleanPrefix ? `${cleanPrefix}/${item.name}` : item.name;

      // En Supabase Storage, las carpetas tienen id === null
      if (!item.id) {
        folders.push({
          name: item.name,
          path: itemPath
        });
        continue;
      }

      const ext = path.extname(item.name).toLowerCase();
      const mime = (item.metadata && item.metadata.mimetype) || '';
      if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
        rawFiles.push({ item, itemPath });
      }
    }

    // Construir URLs públicas (o firmadas si el bucket fuera privado)
    const files = await Promise.all(
      rawFiles.map(async ({ item, itemPath }) => {
        let finalUrl = '';
        if (isPublicBucket) {
          const { data } = supabaseAdmin.storage.from(activeBucket).getPublicUrl(itemPath);
          finalUrl = this.encodePublicStorageUrl(data && data.publicUrl ? data.publicUrl : '');
        } else {
          const { data } = await supabaseAdmin.storage
            .from(activeBucket)
            .createSignedUrl(itemPath, 60 * 60 * 24 * 365);
          finalUrl = data && data.signedUrl ? data.signedUrl : '';
        }

        const sizeBytes = (item.metadata && item.metadata.size) || 0;
        return {
          name: item.name,
          filename: item.name,
          path: itemPath,
          folder: cleanPrefix,
          bucket: activeBucket,
          url: finalUrl,
          sizeKb: Math.max(1, Math.round(sizeBytes / 1024)),
          mimetype: (item.metadata && item.metadata.mimetype) || 'image/jpeg',
          updatedAt: item.updated_at || item.created_at || null
        };
      })
    );

    // Construir migas de pan (breadcrumbs)
    const breadcrumbs = [{ label: `Storage (${activeBucket})`, prefix: '' }];
    if (cleanPrefix) {
      const parts = cleanPrefix.split('/');
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        breadcrumbs.push({ label: part, prefix: acc });
      }
    }

    return {
      bucket: activeBucket,
      buckets: userBuckets.map((b) => ({ name: b.name, public: Boolean(b.public) })),
      prefix: cleanPrefix,
      breadcrumbs,
      rootFolders,
      folders,
      files
    };
  }

  /**
   * Sube un archivo recibido vía Multer hacia Supabase Storage y devuelve su URL pública permanente
   */
  static async uploadMulterFile(file, folder = 'subidas', bucket = DEFAULT_STORAGE_BUCKET) {
    if (!file) return null;
    if (!supabaseAdmin) {
      return `/productos/${encodeURIComponent(file.filename)}`;
    }

    try {
      const cleanFolder = String(folder || 'subidas')
        .replace(/\\/g, '/')
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s && s !== '.' && s !== '..')
        .join('/');

      const objectPath = cleanFolder ? `${cleanFolder}/${file.filename}` : file.filename;
      const buffer = fs.readFileSync(file.path);

      const { error } = await supabaseAdmin.storage.from(bucket).upload(objectPath, buffer, {
        upsert: true,
        contentType: file.mimetype || 'image/jpeg'
      });

      if (error) {
        console.error('[SupabaseCatalogStore] Error subiendo imagen a Storage:', error.message);
        return `/productos/${encodeURIComponent(file.filename)}`;
      }

      const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(objectPath);
      return this.encodePublicStorageUrl(data.publicUrl);
    } catch (err) {
      console.error('[SupabaseCatalogStore] Excepción subiendo imagen a Storage:', err.message);
      return `/productos/${encodeURIComponent(file.filename)}`;
    }
  }

  // =========================================================
  // GESTIÓN DE CLIENTES (TIENDAS) EN SUPABASE
  // =========================================================

  static async getAllClients({ search } = {}) {
    const [clientsRes, productsRes, meta] = await Promise.all([
      supabaseAdmin.from('clientes').select('*').order('id', { ascending: true }),
      supabaseAdmin.from('productos').select('id, cliente_id, precio, inventario'),
      this._loadMeta()
    ]);

    if (clientsRes.error) {
      throw new Error(clientsRes.error.message || 'Error al obtener clientes desde Supabase.');
    }

    const allProducts = productsRes.data || [];
    const metricsByClient = new Map();
    for (const p of allProducts) {
      const cid = Number(p.cliente_id);
      const curr = metricsByClient.get(cid) || { total_productos: 0, total_unidades: 0, valor_inventario: 0 };
      const inv = Number(p.inventario) || 0;
      const price = Number(p.precio) || 0;
      curr.total_productos += 1;
      curr.total_unidades += inv;
      curr.valor_inventario += price * inv;
      metricsByClient.set(cid, curr);
    }

    let list = (clientsRes.data || []).map((c) => {
      const enriched = this.enrichClientRecord(c, meta.clients);
      const m = metricsByClient.get(Number(c.id)) || {
        total_productos: 0,
        total_unidades: 0,
        valor_inventario: 0
      };
      return {
        ...enriched,
        total_productos: m.total_productos,
        total_unidades: m.total_unidades,
        valor_inventario: Number(m.valor_inventario.toFixed(2))
      };
    });

    if (search && search.trim() !== '') {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (c) =>
          (c.nombre && c.nombre.toLowerCase().includes(q)) ||
          (c.slug && c.slug.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q))
      );
    }

    return list;
  }

  static async getClientById(id) {
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .select('*')
      .eq('id', Number(id))
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return null;
    return this.enrichClient(data);
  }

  static async createClient({
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
  }) {
    if (!nombre || !nombre.trim()) {
      throw new Error('El nombre del cliente o comercio es obligatorio.');
    }

    let finalSlug = slug && slug.trim() ? this.generateSlug(slug) : this.generateSlug(nombre);

    // Asegurar unicidad de slug en Supabase
    const { data: existingSlug } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('slug', finalSlug)
      .maybeSingle();

    if (existingSlug) {
      finalSlug = `${finalSlug}-${Math.floor(Math.random() * 899 + 100)}`;
    }

    const { data: inserted, error } = await supabaseAdmin
      .from('clientes')
      .insert([
        {
          nombre: nombre.trim(),
          slug: finalSlug,
          telefono_whatsapp: telefono_whatsapp ? String(telefono_whatsapp).trim() : null,
          logo_url: logo_url ? String(logo_url).trim() : null
        }
      ])
      .select()
      .single();

    if (error) {
      throw new Error(error.message || 'No se pudo registrar el cliente en Supabase.');
    }

    const meta = await this._loadMeta(true);
    meta.clients[String(inserted.id)] = {
      descripcion: (descripcion || '').trim(),
      email: (email || '').trim(),
      portada_url: (portada_url || '').trim(),
      color_primario: color_primario || '#4f46e5',
      moneda_simbolo: (moneda_simbolo || '$').trim(),
      moneda_codigo: (moneda_codigo || 'USD').trim().toUpperCase(),
      activo: 1
    };
    await this._saveMeta(meta);

    return this.enrichClientRecord(inserted, meta.clients);
  }

  static async updateClient(
    id,
    {
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
    }
  ) {
    const current = await this.getClientById(id);
    if (!current) {
      throw new Error('Cliente no encontrado.');
    }

    let finalSlug = current.slug;
    if (slug && slug.trim()) {
      finalSlug = this.generateSlug(slug);
      const { data: conflict } = await supabaseAdmin
        .from('clientes')
        .select('id')
        .eq('slug', finalSlug)
        .neq('id', Number(id))
        .maybeSingle();
      if (conflict) {
        throw new Error(`El slug '${finalSlug}' ya está en uso por otro catálogo.`);
      }
    }

    const nextNombre = nombre !== undefined ? nombre.trim() : current.nombre;
    const nextTel = telefono_whatsapp !== undefined ? String(telefono_whatsapp).trim() : current.telefono_whatsapp;
    const nextLogo = logo_url !== undefined ? String(logo_url).trim() : current.logo_url;

    const { data: updated, error } = await supabaseAdmin
      .from('clientes')
      .update({
        nombre: nextNombre,
        slug: finalSlug,
        telefono_whatsapp: nextTel || null,
        logo_url: nextLogo || null
      })
      .eq('id', Number(id))
      .select()
      .single();

    if (error) {
      throw new Error(error.message || 'Error al actualizar cliente en Supabase.');
    }

    const meta = await this._loadMeta(true);
    const prevExtra = meta.clients[String(id)] || {};
    meta.clients[String(id)] = {
      descripcion: descripcion !== undefined ? descripcion.trim() : prevExtra.descripcion || '',
      email: email !== undefined ? email.trim() : prevExtra.email || '',
      portada_url: portada_url !== undefined ? portada_url.trim() : prevExtra.portada_url || '',
      color_primario: color_primario !== undefined ? color_primario.trim() : prevExtra.color_primario || '#4f46e5',
      moneda_simbolo: moneda_simbolo !== undefined ? moneda_simbolo.trim() : prevExtra.moneda_simbolo || '$',
      moneda_codigo:
        moneda_codigo !== undefined
          ? moneda_codigo.trim().toUpperCase()
          : prevExtra.moneda_codigo || 'USD',
      activo: activo !== undefined ? (activo ? 1 : 0) : prevExtra.activo !== undefined ? prevExtra.activo : 1
    };
    await this._saveMeta(meta);

    return this.enrichClientRecord(updated, meta.clients);
  }

  static async deleteClient(id) {
    const existing = await this.getClientById(id);
    if (!existing) {
      throw new Error('Cliente no encontrado.');
    }

    const { data: prods } = await supabaseAdmin
      .from('productos')
      .select('id')
      .eq('cliente_id', Number(id));

    await supabaseAdmin.from('productos').delete().eq('cliente_id', Number(id));
    const { error } = await supabaseAdmin.from('clientes').delete().eq('id', Number(id));
    if (error) {
      throw new Error(error.message || 'Error al eliminar cliente en Supabase.');
    }

    const meta = await this._loadMeta(true);
    delete meta.clients[String(id)];
    for (const p of prods || []) {
      delete meta.products[String(p.id)];
    }
    await this._saveMeta(meta);

    return { success: true, deleted: existing };
  }

  // =========================================================
  // GESTIÓN DE PRODUCTOS E INVENTARIO EN SUPABASE
  // =========================================================

  static async getAllProducts({
    cliente_id,
    cliente_slug,
    search,
    categoria,
    minPrecio,
    maxPrecio,
    inStock,
    sortBy = 'id',
    sortOrder = 'ASC'
  } = {}) {
    const [clientsRes, meta] = await Promise.all([
      supabaseAdmin.from('clientes').select('id, nombre, slug'),
      this._loadMeta()
    ]);

    const clientsMap = new Map();
    for (const c of clientsRes.data || []) {
      clientsMap.set(Number(c.id), c);
    }

    let targetClientId = null;
    if (cliente_id && cliente_id !== 'all') {
      targetClientId = Number(cliente_id);
    } else if (cliente_slug && cliente_slug !== 'all') {
      const matched = Array.from(clientsMap.values()).find(
        (c) => c.slug && c.slug.toLowerCase() === cliente_slug.trim().toLowerCase()
      );
      if (!matched) return [];
      targetClientId = Number(matched.id);
    }

    let query = supabaseAdmin.from('productos').select('*');
    if (targetClientId !== null && !isNaN(targetClientId)) {
      query = query.eq('cliente_id', targetClientId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message || 'Error al obtener productos desde Supabase.');
    }

    let list = (data || []).map((p) => this.enrichProductRecord(p, meta.products, clientsMap));

    if (search && search.trim() !== '') {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          (p.nombre && p.nombre.toLowerCase().includes(q)) ||
          (p.descripcion && p.descripcion.toLowerCase().includes(q)) ||
          (p.categoria && p.categoria.toLowerCase().includes(q))
      );
    }

    if (categoria && categoria !== 'all' && categoria !== '') {
      list = list.filter((p) => p.categoria === categoria);
    }

    if (minPrecio !== undefined && minPrecio !== '') {
      list = list.filter((p) => p.precio >= Number(minPrecio));
    }

    if (maxPrecio !== undefined && maxPrecio !== '') {
      list = list.filter((p) => p.precio <= Number(maxPrecio));
    }

    if (inStock === 'true' || inStock === true) {
      list = list.filter((p) => p.inventario > 0);
    }

    const dir = String(sortOrder || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
    const allowedSort = ['id', 'nombre', 'precio', 'inventario', 'categoria'];
    const field = allowedSort.includes(sortBy) ? sortBy : 'id';

    list.sort((a, b) => {
      if (typeof a[field] === 'string') {
        return a[field].localeCompare(b[field], 'es', { sensitivity: 'base' }) * dir;
      }
      return (Number(a[field]) - Number(b[field])) * dir;
    });

    return list;
  }

  static async getProductById(id) {
    const [prodRes, meta] = await Promise.all([
      supabaseAdmin.from('productos').select('*').eq('id', Number(id)).maybeSingle(),
      this._loadMeta()
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    if (!prodRes.data) return null;

    const client = await this.getClientById(prodRes.data.cliente_id);
    const clientsMap = new Map();
    if (client) clientsMap.set(Number(client.id), client);

    const enriched = this.enrichProductRecord(prodRes.data, meta.products, clientsMap);
    if (client) {
      enriched.cliente_whatsapp = client.telefono_whatsapp || '';
    }
    return enriched;
  }

  static async createProduct({ cliente_id, nombre, descripcion, precio, inventario, categoria, imagen_url }) {
    if (!cliente_id) {
      throw new Error('Debe seleccionar el cliente o tienda al que pertenece el producto.');
    }
    if (!nombre || !nombre.trim()) {
      throw new Error('El nombre del producto es obligatorio.');
    }
    if (precio === undefined || isNaN(Number(precio)) || Number(precio) < 0) {
      throw new Error('El precio debe ser un número mayor o igual a 0.');
    }

    const parsedInv =
      inventario !== undefined && inventario !== '' && !isNaN(Number(inventario))
        ? Math.max(0, Math.floor(Number(inventario)))
        : 0;

    const { data: inserted, error } = await supabaseAdmin
      .from('productos')
      .insert([
        {
          cliente_id: Number(cliente_id),
          nombre: nombre.trim(),
          descripcion: descripcion ? descripcion.trim() : null,
          precio: Number(Number(precio).toFixed(2)),
          inventario: parsedInv,
          imagen_url: imagen_url ? imagen_url.trim() : null
        }
      ])
      .select()
      .single();

    if (error) {
      if (error.code === '23503') {
        throw new Error('El cliente seleccionado no existe en la base de datos. Cree primero la tienda.');
      }
      throw new Error(error.message || 'Error al guardar el producto en Supabase.');
    }

    const cleanCat = categoria && categoria.trim() ? categoria.trim() : 'General';
    const meta = await this._loadMeta(true);
    meta.products[String(inserted.id)] = { categoria: cleanCat };
    await this._saveMeta(meta);

    return this.getProductById(inserted.id);
  }

  static async updateProduct(id, { cliente_id, nombre, descripcion, precio, inventario, categoria, imagen_url }) {
    const existing = await this.getProductById(id);
    if (!existing) {
      throw new Error('Producto no encontrado.');
    }

    const nextClienteId = cliente_id ? Number(cliente_id) : Number(existing.cliente_id);
    const nextNombre = nombre !== undefined ? nombre.trim() : existing.nombre;
    const nextDesc = descripcion !== undefined ? descripcion.trim() : existing.descripcion;
    const nextPrecio = precio !== undefined ? Number(Number(precio).toFixed(2)) : Number(existing.precio);
    const nextInv =
      inventario !== undefined ? Math.max(0, Math.floor(Number(inventario))) : Number(existing.inventario);
    const nextImg = imagen_url !== undefined ? imagen_url.trim() : existing.imagen_url;

    if (nextPrecio < 0) throw new Error('El precio no puede ser negativo.');

    const { error } = await supabaseAdmin
      .from('productos')
      .update({
        cliente_id: nextClienteId,
        nombre: nextNombre,
        descripcion: nextDesc || null,
        precio: nextPrecio,
        inventario: nextInv,
        imagen_url: nextImg || null
      })
      .eq('id', Number(id));

    if (error) {
      throw new Error(error.message || 'Error al actualizar el producto en Supabase.');
    }

    if (categoria !== undefined && categoria.trim() !== '') {
      const meta = await this._loadMeta(true);
      meta.products[String(id)] = { categoria: categoria.trim() };
      await this._saveMeta(meta);
    }

    return this.getProductById(id);
  }

  static async adjustProductStock(id, { delta, absolute }) {
    const existing = await this.getProductById(id);
    if (!existing) {
      throw new Error('Producto no encontrado.');
    }

    let nextStock = Number(existing.inventario) || 0;
    if (absolute !== undefined) {
      nextStock = Math.floor(Number(absolute));
    } else if (delta !== undefined) {
      nextStock += Math.floor(Number(delta));
    }
    if (nextStock < 0) nextStock = 0;

    const { error } = await supabaseAdmin
      .from('productos')
      .update({ inventario: nextStock })
      .eq('id', Number(id));

    if (error) {
      throw new Error(error.message || 'Error al ajustar el inventario en Supabase.');
    }

    return this.getProductById(id);
  }

  static async deleteProduct(id) {
    const existing = await this.getProductById(id);
    if (!existing) {
      throw new Error('Producto no encontrado.');
    }

    const { error } = await supabaseAdmin.from('productos').delete().eq('id', Number(id));
    if (error) {
      throw new Error(error.message || 'Error al eliminar producto en Supabase.');
    }

    const meta = await this._loadMeta(true);
    if (meta.products[String(id)]) {
      delete meta.products[String(id)];
      await this._saveMeta(meta);
    }

    return { success: true, deleted: existing };
  }

  static async getCategories(clienteId = null) {
    const products = await this.getAllProducts({ cliente_id: clienteId });
    const counts = new Map();
    for (const p of products) {
      const cat = p.categoria || 'General';
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([categoria, count]) => ({ categoria, count }))
      .sort((a, b) => b.count - a.count);
  }

  static async getStats(clienteId = null) {
    const products = await this.getAllProducts({ cliente_id: clienteId });
    let total_unidades = 0;
    let valor_total_inventario = 0;
    let stock_bajo = 0;
    let agotados = 0;

    const counts = new Map();
    for (const p of products) {
      const inv = Number(p.inventario) || 0;
      const price = Number(p.precio) || 0;
      total_unidades += inv;
      valor_total_inventario += price * inv;
      if (inv === 0) agotados += 1;
      else if (inv <= 5) stock_bajo += 1;

      const cat = p.categoria || 'General';
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }

    const categorias = Array.from(counts.entries())
      .map(([categoria, count]) => ({ categoria, count }))
      .sort((a, b) => b.count - a.count);

    return {
      total_productos: products.length,
      total_unidades,
      valor_total_inventario: Number(valor_total_inventario.toFixed(2)),
      stock_bajo,
      agotados,
      categorias
    };
  }
}

module.exports = SupabaseCatalogStore;
