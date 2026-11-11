/**
 * Frontend del Catálogo Digital Público y Estático
 * Aislamiento estricto de datos: filtra y presenta productos exclusivamente
 * según el slug del cliente extraído del enlace único (/c/:slug).
 * Consume dinámicamente /api/clientes, /api/productos/:cliente_id y /api/pedidos.
 * Sin selector de tiendas ni enlaces al panel de administración.
 */

// Base de URL configurable según el entorno (por defecto rutas relativas '')
const API_BASE_URL = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL)
  ? window.APP_CONFIG.API_BASE_URL.replace(/\/$/, '')
  : '';

function apiUrl(endpoint) {
  return `${API_BASE_URL}${endpoint}`;
}

const state = {
  clientSlug: null,
  clientInfo: null,
  dataSource: 'supabase',
  currencySymbol: '$',
  currencyCode: 'USD',
  allProducts: [],
  products: [],
  categories: [],
  selectedCategory: 'all',
  searchQuery: '',
  sortBy: 'id',
  sortOrder: 'ASC',
  onlyInStock: false,
  cart: [],
  isSubmittingOrder: false
};

// Elementos del DOM
const productsGrid = document.getElementById('products-grid');
const categoryTabs = document.getElementById('category-tabs');
const searchInput = document.getElementById('search-input');
const sortSelect = document.getElementById('sort-select');
const inStockCheckbox = document.getElementById('in-stock-checkbox');
const resultsCount = document.getElementById('results-count');
const catalogControlsBar = document.getElementById('catalog-controls-bar');
const cartBadge = document.getElementById('cart-badge');
const cartDrawer = document.getElementById('cart-drawer');
const cartItemsContainer = document.getElementById('cart-items');
const cartTotalAmount = document.getElementById('cart-total-amount');
const buyerFormContainer = document.getElementById('buyer-form-container');
const buyerNameInput = document.getElementById('buyer-name');
const buyerPhoneInput = document.getElementById('buyer-phone');
const buyerAddressInput = document.getElementById('buyer-address');
const btnCheckoutWhatsApp = document.getElementById('btn-checkout-whatsapp');
const btnCheckoutLabel = document.getElementById('btn-checkout-label');
const productModal = document.getElementById('product-modal');
const toastContainer = document.getElementById('toast-container');

// Elementos de Personalización de Marca del Cliente
const brandTitle = document.getElementById('brand-title');
const heroTitle = document.getElementById('hero-title');
const heroSubtitle = document.getElementById('hero-subtitle');
const footerBrand = document.getElementById('footer-brand');

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
  resolveClientSlug();
  loadBuyerInfoFromStorage();
  setupEventListeners();

  if (!state.clientSlug) {
    showNoSlugMessage();
    return;
  }

  loadCartFromStorage();
  updateCartUI();
  await loadCatalogData();
});

// Extraer el slug del cliente exclusivamente de la ruta o parámetro de URL
function resolveClientSlug() {
  const path = window.location.pathname;
  const match = path.match(/^\/(?:c|catalogo)\/([^\/]+)/);

  if (match && match[1]) {
    state.clientSlug = decodeURIComponent(match[1].trim());
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const querySlug = urlParams.get('c') || urlParams.get('cliente');
  if (querySlug && querySlug.trim() !== '') {
    state.clientSlug = decodeURIComponent(querySlug.trim());
    return;
  }

  state.clientSlug = null;
}

// Pantalla cuando no se especifica un slug en la URL
function showNoSlugMessage() {
  if (catalogControlsBar) catalogControlsBar.style.display = 'none';

  productsGrid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 4.5rem 1.5rem; background: #fff; border-radius: var(--radius-lg); border: 1px dashed var(--border-light); max-width: 620px; margin: 2rem auto; box-shadow: var(--shadow-sm);">
      <span style="font-size: 3.25rem; display: block; margin-bottom: 1rem;">🔒</span>
      <h2 style="font-size: 1.35rem; font-weight: 800; color: var(--text-main); margin-bottom: 0.5rem;">
        Catálogo Privado por Enlace Único
      </h2>
      <p style="color: var(--text-muted); font-size: 0.9375rem; line-height: 1.6;">
        Para explorar el catálogo y realizar pedidos, por favor accede a través del enlace web exclusivo proporcionado directamente por tu comercio o proveedor.
      </p>
    </div>
  `;
}

// Normalizar campos de cada producto proveniente de Supabase o catálogo local
function normalizeProduct(p) {
  const hasWholesale =
    p.precio_mayor !== undefined && p.precio_mayor !== null && p.precio_mayor !== '' && Number(p.precio_mayor) > 0;
  return {
    id: p.id,
    cliente_id: p.cliente_id,
    nombre: p.nombre || 'Producto',
    descripcion: p.descripcion || 'Producto disponible en catálogo.',
    precio: Number(p.precio) || 0,
    precio_mayor: hasWholesale ? Number(p.precio_mayor) : null,
    inventario: p.inventario !== undefined && p.inventario !== null ? Number(p.inventario) : 10,
    categoria: p.categoria || 'General',
    imagen_url: p.imagen_url || 'https://placehold.co/400x400/e2e8f0/475569?text=Producto'
  };
}

// Construir conteo de categorías dinámicamente a partir de los productos del cliente
function buildCategoriesFromProducts(products) {
  const counts = new Map();
  products.forEach(p => {
    const cat = p.categoria || 'General';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  });
  return Array.from(counts.entries()).map(([categoria, count]) => ({ categoria, count }));
}

// Consulta dinámica de cliente (/api/clientes) y sus productos (/api/productos/:cliente_id)
async function loadCatalogData() {
  try {
    productsGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 4rem 1rem; color: var(--text-muted);">
        <p style="font-size: 1rem;">Cargando catálogo...</p>
      </div>
    `;

    // 1. Obtener datos del comercio vía /api/clientes
    const clientRes = await fetch(apiUrl(`/api/clientes?slug=${encodeURIComponent(state.clientSlug)}`));
    const clientJson = await clientRes.json();

    if (!clientRes.ok || !clientJson.success || !clientJson.data) {
      if (catalogControlsBar) catalogControlsBar.style.display = 'none';
      productsGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 4rem 1.5rem; background: #fff; border-radius: var(--radius-lg); border: 1px dashed var(--border-light); max-width: 580px; margin: 2rem auto;">
          <span style="font-size: 3rem; display: block; margin-bottom: 0.75rem;">🏬</span>
          <h3 style="font-size: 1.25rem; font-weight: 800; margin-bottom: 0.5rem; color: var(--text-main);">Catálogo No Disponible</h3>
          <p style="color: var(--text-muted); font-size: 0.9375rem;">
            El catálogo solicitado no existe o ha sido desactivado temporalmente.
          </p>
        </div>
      `;
      return;
    }

    state.clientInfo = clientJson.data;
    state.dataSource = clientJson.source || 'supabase';
    state.currencySymbol = clientJson.data.moneda_simbolo || '$';
    state.currencyCode = clientJson.data.moneda_codigo || 'USD';

    // Aplicar identidad de marca y moneda
    applyClientBranding(state.clientInfo);
    updateCartUI();

    // 2. Obtener listado de productos del comercio vía /api/productos/:cliente_id
    const sourceQuery = state.dataSource === 'local' ? '?source=local' : '';
    const prodRes = await fetch(apiUrl(`/api/productos/${encodeURIComponent(state.clientInfo.id)}${sourceQuery}`));
    const prodJson = await prodRes.json();

    if (!prodRes.ok || !prodJson.success) {
      throw new Error(prodJson.error || 'No se pudieron cargar los productos.');
    }

    if (catalogControlsBar) catalogControlsBar.style.display = 'block';

    const rawList = Array.isArray(prodJson.productos) ? prodJson.productos : (prodJson.data || []);
    state.allProducts = rawList.map(normalizeProduct);
    state.categories = buildCategoriesFromProducts(state.allProducts);

    renderCategoryTabs();
    applyFiltersAndRender();
  } catch (err) {
    console.error('Error al cargar catálogo:', err);
    productsGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #ef4444;">
        <p>No se pudo conectar con el catálogo. Verifique su conexión.</p>
      </div>
    `;
  }
}

// Aplicar filtros, búsqueda y ordenamiento sobre los productos cargados del comercio
function applyFiltersAndRender() {
  let filtered = [...state.allProducts];

  if (state.selectedCategory !== 'all') {
    filtered = filtered.filter(p => p.categoria === state.selectedCategory);
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(p =>
      p.nombre.toLowerCase().includes(q) ||
      p.descripcion.toLowerCase().includes(q) ||
      p.categoria.toLowerCase().includes(q)
    );
  }

  if (state.onlyInStock) {
    filtered = filtered.filter(p => p.inventario > 0);
  }

  filtered.sort((a, b) => {
    let valA = a[state.sortBy];
    let valB = b[state.sortBy];

    if (typeof valA === 'string') {
      const cmp = valA.localeCompare(valB, 'es', { sensitivity: 'base' });
      return state.sortOrder === 'DESC' ? -cmp : cmp;
    }

    const diff = Number(valA) - Number(valB);
    return state.sortOrder === 'DESC' ? -diff : diff;
  });

  state.products = filtered;
  renderProducts(filtered);
  resultsCount.textContent = `${filtered.length} producto${filtered.length === 1 ? '' : 's'} disponible${filtered.length === 1 ? '' : 's'}`;
}

// Aplicar branding del cliente dueño del catálogo
function applyClientBranding(client) {
  document.title = `${client.nombre} | Catálogo Digital`;

  if (brandTitle) brandTitle.textContent = client.nombre;
  if (heroTitle) heroTitle.textContent = client.nombre;
  if (heroSubtitle) {
    heroSubtitle.textContent = client.descripcion || 'Explora nuestra colección con inventario disponible en tiempo real.';
  }
  if (footerBrand) {
    footerBrand.textContent = `${client.nombre} © 2026`;
  }

  // 1. Logotipo de la tienda (en navbar y en hero)
  const brandLogoImg = document.getElementById('brand-logo-img');
  const brandIconDefault = document.getElementById('brand-icon-default');
  const heroLogoContainer = document.getElementById('hero-logo-container');
  const heroLogoImg = document.getElementById('hero-logo-img');

  if (client.logo_url && client.logo_url.trim() !== '') {
    if (brandLogoImg) {
      brandLogoImg.src = client.logo_url;
      brandLogoImg.style.display = 'block';
    }
    if (brandIconDefault) {
      brandIconDefault.style.display = 'none';
    }
    if (heroLogoContainer && heroLogoImg) {
      heroLogoImg.src = client.logo_url;
      heroLogoContainer.style.display = 'inline-flex';
    }
  } else {
    if (brandLogoImg) brandLogoImg.style.display = 'none';
    if (brandIconDefault) brandIconDefault.style.display = 'flex';
    if (heroLogoContainer) heroLogoContainer.style.display = 'none';
  }

  // 2. Foto de Portada / Banner de fondo en el rectángulo del nombre
  const heroSection = document.getElementById('hero-section');
  if (heroSection) {
    if (client.portada_url && client.portada_url.trim() !== '') {
      heroSection.style.backgroundImage = `url('${client.portada_url}')`;
      heroSection.classList.add('has-cover');
    } else {
      heroSection.style.backgroundImage = '';
      heroSection.classList.remove('has-cover');
    }
  }

  // 3. Color personalizado de la marca del cliente
  if (client.color_primario) {
    document.documentElement.style.setProperty('--primary', client.color_primario);
    document.documentElement.style.setProperty('--primary-dark', client.color_primario);
  }
}

// Event Listeners
function setupEventListeners() {
  // Búsqueda con debounce dentro del catálogo
  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = e.target.value.trim();
      applyFiltersAndRender();
    }, 180);
  });

  // Ordenamiento
  sortSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    const [by, order] = val.split('-');
    state.sortBy = by;
    state.sortOrder = order;
    applyFiltersAndRender();
  });

  // Filtro de solo stock
  inStockCheckbox.addEventListener('change', (e) => {
    state.onlyInStock = e.target.checked;
    applyFiltersAndRender();
  });

  // Guardar datos del comprador al escribir
  [buyerNameInput, buyerPhoneInput, buyerAddressInput].forEach(input => {
    if (input) {
      input.addEventListener('input', saveBuyerInfoToStorage);
    }
  });

  // Carrito Drawer
  document.getElementById('cart-btn').addEventListener('click', toggleCartDrawer);
  document.getElementById('close-cart-btn').addEventListener('click', toggleCartDrawer);
  document.getElementById('cart-backdrop').addEventListener('click', toggleCartDrawer);
  btnCheckoutWhatsApp.addEventListener('click', checkoutWhatsApp);

  // Modal de Detalle
  document.getElementById('close-modal-btn').addEventListener('click', closeProductModal);
  productModal.addEventListener('click', (e) => {
    if (e.target === productModal) closeProductModal();
  });
}

// Renderizar pestañas de categorías
function renderCategoryTabs() {
  let html = `
    <button class="category-tab ${state.selectedCategory === 'all' ? 'active' : ''}" data-category="all">
      Todos los Productos (${state.allProducts.length})
    </button>
  `;

  state.categories.forEach(cat => {
    html += `
      <button class="category-tab ${state.selectedCategory === cat.categoria ? 'active' : ''}" data-category="${cat.categoria}">
        ${cat.categoria} (${cat.count})
      </button>
    `;
  });

  categoryTabs.innerHTML = html;

  categoryTabs.querySelectorAll('.category-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      categoryTabs.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.selectedCategory = tab.dataset.category;
      applyFiltersAndRender();
    });
  });
}

// Renderizar tarjetas de productos
function renderProducts(products) {
  if (products.length === 0) {
    productsGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 4rem 1rem; background: #fff; border-radius: var(--radius-lg); border: 1px dashed var(--border-light);">
        <span style="font-size: 2.5rem; display: block; margin-bottom: 0.5rem;">🔍</span>
        <h3 style="font-size: 1.125rem; font-weight: 700; margin-bottom: 0.25rem;">No se encontraron productos</h3>
        <p style="color: var(--text-muted); font-size: 0.875rem;">Intenta con otros términos o selecciona otra categoría.</p>
      </div>
    `;
    return;
  }

  productsGrid.innerHTML = products.map(p => {
    let stockBadgeClass = 'badge-stock-in';
    let stockText = `${p.inventario} disponibles`;

    if (p.inventario === 0) {
      stockBadgeClass = 'badge-stock-out';
      stockText = 'Agotado';
    } else if (p.inventario <= 5) {
      stockBadgeClass = 'badge-stock-low';
      stockText = `¡Últimas ${p.inventario} unid.!`;
    }

    return `
      <article class="product-card">
        <div class="product-image-container" onclick="openProductDetail(${p.id})">
          <img 
            src="${p.imagen_url}" 
            alt="${p.nombre}" 
            class="product-image" 
            loading="lazy"
            onerror="this.onerror=null; this.src='https://placehold.co/400x400/e2e8f0/475569?text=Sin+Imagen';"
          />
          <div class="product-category-overlay">
            <span class="badge badge-category">${p.categoria}</span>
          </div>
          <div class="product-stock-overlay">
            <span class="badge ${stockBadgeClass}">${stockText}</span>
          </div>
        </div>

        <div class="product-card-body">
          <h3 class="product-title" onclick="openProductDetail(${p.id})" style="cursor: pointer;" title="${p.nombre}">
            ${p.nombre}
          </h3>
          <p class="product-description-snippet">${p.descripcion}</p>

          <div class="product-footer">
            <div>
              <div class="product-price">
                ${state.currencySymbol}${Number(p.precio).toFixed(2)}
              </div>
              ${
                p.precio_mayor && Number(p.precio_mayor) > 0
                  ? `<div style="font-size: 0.75rem; font-weight: 700; color: #047857; margin-top: 2px;">Al mayor: ${state.currencySymbol}${Number(p.precio_mayor).toFixed(2)}</div>`
                  : ''
              }
            </div>
            <div class="product-actions">
              <button class="btn btn-secondary btn-sm" onclick="openProductDetail(${p.id})" title="Ver detalles completos">
                Detalles
              </button>
              <button 
                class="btn btn-primary btn-sm" 
                onclick="addToCart(${p.id})"
                ${p.inventario === 0 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}
                title="Agregar al pedido"
              >
                + Pedir
              </button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// Modal de Detalle
function openProductDetail(id) {
  const product = state.allProducts.find(p => p.id === id) || state.products.find(p => p.id === id);
  if (!product) return;

  const modalBody = document.getElementById('product-modal-body');

  let stockBadgeClass = 'badge-stock-in';
  let stockText = `${product.inventario} unidades disponibles en inventario`;

  if (product.inventario === 0) {
    stockBadgeClass = 'badge-stock-out';
    stockText = 'Producto actualmente agotado';
  } else if (product.inventario <= 5) {
    stockBadgeClass = 'badge-stock-low';
    stockText = `¡Stock bajo! Solo quedan ${product.inventario} unidades`;
  }

  modalBody.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; align-items: start;">
      <div style="border-radius: var(--radius-md); overflow: hidden; background: #f8fafc; border: 1px solid var(--border-light);">
        <img 
          src="${product.imagen_url}" 
          alt="${product.nombre}" 
          style="width: 100%; height: auto; max-height: 380px; object-fit: contain; margin: 0 auto;"
          onerror="this.src='https://placehold.co/400x400/e2e8f0/475569?text=Sin+Imagen';"
        />
      </div>
      <div>
        <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap;">
          <span class="badge badge-category">${product.categoria}</span>
          <span class="badge ${stockBadgeClass}">${stockText}</span>
        </div>
        <h2 style="font-size: 1.5rem; font-weight: 800; line-height: 1.25; margin-bottom: 0.75rem;">${product.nombre}</h2>
        <div style="display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem;">
          <div style="font-size: 1.75rem; font-weight: 800; color: var(--primary);">
            ${state.currencySymbol}${Number(product.precio).toFixed(2)}
            <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">(Detal)</span>
          </div>
          ${
            product.precio_mayor && Number(product.precio_mayor) > 0
              ? `<div style="background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; padding: 0.3rem 0.75rem; border-radius: var(--radius-md); font-size: 0.95rem; font-weight: 800;">
                  🏷️ Al Mayor: ${state.currencySymbol}${Number(product.precio_mayor).toFixed(2)}
                </div>`
              : ''
          }
        </div>
        
        <h4 style="font-size: 0.875rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 0.375rem;">Descripción</h4>
        <p style="font-size: 0.9375rem; color: #334155; line-height: 1.6; margin-bottom: 1.5rem; white-space: pre-line;">${product.descripcion}</p>

        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          <button 
            class="btn btn-primary" 
            style="width: 100%;" 
            onclick="addToCart(${product.id}); closeProductModal();"
            ${product.inventario === 0 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}
          >
            🛒 Agregar al Pedido
          </button>
          
          <button 
            class="btn btn-whatsapp" 
            style="width: 100%;" 
            onclick="consultProductWhatsApp(${product.id})"
          >
            💬 Consultar por WhatsApp
          </button>
        </div>
      </div>
    </div>
  `;

  productModal.classList.add('active');
}

function closeProductModal() {
  productModal.classList.remove('active');
}

// Consulta rápida directa al WhatsApp del Cliente
function consultProductWhatsApp(id) {
  const p = state.allProducts.find(item => item.id === id) || state.products.find(item => item.id === id);
  if (!p || !state.clientInfo) return;

  const targetWhatsApp = state.clientInfo.telefono_whatsapp
    ? state.clientInfo.telefono_whatsapp.replace(/[^0-9]/g, '')
    : '584120000000';

  const wholesaleLine =
    p.precio_mayor && Number(p.precio_mayor) > 0
      ? `\n🏷️ Precio al Mayor: ${state.currencySymbol}${Number(p.precio_mayor).toFixed(2)} ${state.currencyCode}`
      : '';

  const text = `¡Hola *${state.clientInfo.nombre}*! Me interesa este producto de su catálogo:
📦 *${p.nombre}*
🏷️ Categoría: ${p.categoria}
💵 Precio: ${state.currencySymbol}${Number(p.precio).toFixed(2)} ${state.currencyCode}${wholesaleLine}
ID: #${p.id}

¿Tienen disponibilidad para compra o envío inmediato?`;

  const url = `https://wa.me/${targetWhatsApp}?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank');
}

// Persistencia de datos del comprador en localStorage
function loadBuyerInfoFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem('catalogo_buyer_info') || '{}');
    if (buyerNameInput && saved.nombre) buyerNameInput.value = saved.nombre;
    if (buyerPhoneInput && saved.telefono) buyerPhoneInput.value = saved.telefono;
    if (buyerAddressInput && saved.direccion) buyerAddressInput.value = saved.direccion;
  } catch (err) {}
}

function saveBuyerInfoToStorage() {
  try {
    const info = {
      nombre: buyerNameInput ? buyerNameInput.value : '',
      telefono: buyerPhoneInput ? buyerPhoneInput.value : '',
      direccion: buyerAddressInput ? buyerAddressInput.value : ''
    };
    localStorage.setItem('catalogo_buyer_info', JSON.stringify(info));
  } catch (err) {}
}

// Carrito Scoped exclusivamente al cliente activo
function loadCartFromStorage() {
  if (!state.clientSlug) return;
  const cartKey = `cart_${state.clientSlug}`;
  state.cart = JSON.parse(localStorage.getItem(cartKey) || '[]');
}

function saveCart() {
  if (!state.clientSlug) return;
  const cartKey = `cart_${state.clientSlug}`;
  localStorage.setItem(cartKey, JSON.stringify(state.cart));
}

function addToCart(productId) {
  const product = state.allProducts.find(p => p.id === productId) || state.products.find(p => p.id === productId);
  if (!product) return;

  if (product.inventario <= 0) {
    showToast('El producto seleccionado se encuentra agotado.', 'error');
    return;
  }

  const existing = state.cart.find(item => item.id === productId);
  if (existing) {
    if (existing.qty >= product.inventario) {
      showToast(`Stock máximo alcanzado (${product.inventario} unidades).`, 'error');
      return;
    }
    existing.qty += 1;
  } else {
    state.cart.push({
      id: product.id,
      nombre: product.nombre,
      precio: product.precio,
      imagen_url: product.imagen_url,
      categoria: product.categoria,
      maxStock: product.inventario,
      qty: 1
    });
  }

  saveCart();
  updateCartUI();
  showToast(`"${product.nombre}" agregado al pedido.`);
}

function updateQty(id, delta) {
  const item = state.cart.find(i => i.id === id);
  if (!item) return;

  item.qty += delta;
  if (item.qty <= 0) {
    state.cart = state.cart.filter(i => i.id !== id);
  } else if (item.qty > item.maxStock) {
    item.qty = item.maxStock;
    showToast('Stock máximo disponible alcanzado.', 'error');
  }

  saveCart();
  updateCartUI();
}

function removeFromCart(id) {
  state.cart = state.cart.filter(i => i.id !== id);
  saveCart();
  updateCartUI();
  showToast('Producto eliminado del pedido.');
}

function updateCartUI() {
  const totalItems = state.cart.reduce((sum, item) => sum + item.qty, 0);
  cartBadge.textContent = totalItems;
  cartBadge.style.display = totalItems > 0 ? 'inline-flex' : 'none';

  if (state.cart.length === 0) {
    if (buyerFormContainer) buyerFormContainer.style.display = 'none';
    cartItemsContainer.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <span style="font-size: 2.5rem; display: block; margin-bottom: 0.5rem;">🛒</span>
        <p>Tu lista de pedido está vacía.</p>
        <span style="font-size: 0.8125rem;">Agrega productos desde el catálogo para consultar o realizar tu orden.</span>
      </div>
    `;
    cartTotalAmount.textContent = `${state.currencySymbol}0.00`;
    return;
  }

  if (buyerFormContainer) buyerFormContainer.style.display = 'block';

  let total = 0;
  cartItemsContainer.innerHTML = state.cart.map(item => {
    const itemSubtotal = item.precio * item.qty;
    total += itemSubtotal;
    return `
      <div class="drawer-item">
        <img src="${item.imagen_url}" alt="${item.nombre}" class="drawer-item-img" />
        <div class="drawer-item-info">
          <div class="drawer-item-title">${item.nombre}</div>
          <div class="drawer-item-price">${state.currencySymbol}${Number(item.precio).toFixed(2)} c/u</div>
          <div style="font-size: 0.75rem; color: var(--text-subtle); margin-top: 2px;">Subtotal: ${state.currencySymbol}${itemSubtotal.toFixed(2)}</div>
        </div>
        <div class="drawer-item-qty">
          <button class="qty-btn" onclick="updateQty(${item.id}, -1)">-</button>
          <span style="font-size: 0.875rem; font-weight: 700; width: 1.25rem; text-align: center;">${item.qty}</span>
          <button class="qty-btn" onclick="updateQty(${item.id}, 1)">+</button>
          <button onclick="removeFromCart(${item.id})" style="color: #ef4444; margin-left: 0.5rem; font-size: 1rem;" title="Eliminar">✕</button>
        </div>
      </div>
    `;
  }).join('');

  cartTotalAmount.textContent = `${state.currencySymbol}${total.toFixed(2)}`;
}

function toggleCartDrawer() {
  cartDrawer.classList.toggle('active');
}

// Procesar carrito vía POST /api/pedidos y redirigir automáticamente usando whatsapp_url
async function checkoutWhatsApp() {
  if (state.isSubmittingOrder) return;

  if (state.cart.length === 0 || !state.clientInfo) {
    showToast('Tu pedido está vacío.', 'error');
    return;
  }

  const buyerName = buyerNameInput ? buyerNameInput.value.trim() : '';
  const buyerPhone = buyerPhoneInput ? buyerPhoneInput.value.trim() : '';
  const buyerAddress = buyerAddressInput ? buyerAddressInput.value.trim() : '';

  if (!buyerName) {
    showToast('Por favor ingresa tu nombre completo para enviar el pedido.', 'error');
    if (buyerNameInput) buyerNameInput.focus();
    return;
  }

  if (!buyerPhone) {
    showToast('Por favor ingresa tu número de teléfono de contacto.', 'error');
    if (buyerPhoneInput) buyerPhoneInput.focus();
    return;
  }

  saveBuyerInfoToStorage();

  state.isSubmittingOrder = true;
  if (btnCheckoutWhatsApp) btnCheckoutWhatsApp.disabled = true;
  if (btnCheckoutLabel) btnCheckoutLabel.textContent = 'Generando enlace de pedido...';

  try {
    const payload = {
      cliente_id: state.clientInfo.id,
      cliente_slug: state.clientSlug,
      source: state.dataSource,
      comprador: {
        nombre: buyerName,
        telefono: buyerPhone,
        direccion: buyerAddress
      },
      items: state.cart.map(item => ({
        producto_id: item.id,
        nombre: item.nombre,
        cantidad: item.qty,
        precio_unitario: Number(item.precio)
      }))
    };

    const res = await fetch(apiUrl('/api/pedidos'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await res.json();

    if (!res.ok || !result.success || !result.whatsapp_url) {
      showToast(result.error || 'No se pudo procesar el pedido.', 'error');
      return;
    }

    // Redirigir automáticamente al usuario usando whatsapp_url devuelto por el backend
    const popup = window.open(result.whatsapp_url, '_blank');
    if (!popup) {
      window.location.href = result.whatsapp_url;
    }
  } catch (err) {
    console.error('Error al procesar checkout en /api/pedidos:', err);
    showToast('Error de red al procesar el pedido. Inténtalo de nuevo.', 'error');
  } finally {
    state.isSubmittingOrder = false;
    if (btnCheckoutWhatsApp) btnCheckoutWhatsApp.disabled = false;
    if (btnCheckoutLabel) btnCheckoutLabel.textContent = 'Enviar Pedido por WhatsApp';
  }
}

// Toast
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'toast-error' : 'toast-success'}`;
  toast.textContent = message;

  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}
