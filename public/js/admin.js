/**
 * Lógica del Panel de Super-Administrador
 * Generador Multi-Inquilino de Catálogos Digitales
 */

const adminState = {
  token: localStorage.getItem('admin_token') || '',
  adminUser: null,
  activeClientId: localStorage.getItem('admin_active_client_id') || 'all',
  clients: [],
  products: [],
  categories: [],
  stats: null,
  localImages: [],
  storage: {
    bucket: 'productos',
    buckets: [],
    prefix: '',
    breadcrumbs: [],
    rootFolders: [],
    folders: [],
    files: [],
    searchQuery: '',
    selectMode: false,
    loading: false
  },
  activeEditingProductId: null,
  activeEditingClientId: null,
  deleteTarget: null, // { type: 'product'|'client', id: ... }
  galleryTarget: 'product' // 'product' | 'client-logo' | 'client-cover'
};

// DOM Elements
const adminActiveClientSelect = document.getElementById('admin-active-client-select');
const btnViewActiveCatalog = document.getElementById('btn-view-active-catalog');
const btnCopyActiveLink = document.getElementById('btn-copy-active-link');
const tabProductsBtn = document.getElementById('tab-products-btn');
const tabClientsBtn = document.getElementById('tab-clients-btn');
const viewProducts = document.getElementById('view-products');
const viewClients = document.getElementById('view-clients');
const badgeTotalClients = document.getElementById('badge-total-clients');

// KPIs
const kpiTotalProducts = document.getElementById('kpi-total-products');
const kpiTotalValue = document.getElementById('kpi-total-value');
const kpiLowStock = document.getElementById('kpi-low-stock');
const kpiOutOfStock = document.getElementById('kpi-out-of-stock');

// Tablas & Listas
const adminTableBody = document.getElementById('admin-table-body');
const searchAdminInput = document.getElementById('search-admin');
const filterAdminCategory = document.getElementById('filter-admin-category');
const filterAdminStock = document.getElementById('filter-admin-stock');
const clientsGrid = document.getElementById('clients-grid');
const catalogHeadingTitle = document.getElementById('catalog-heading-title');
const catalogHeadingSubtitle = document.getElementById('catalog-heading-subtitle');

// Modales
const productFormModal = document.getElementById('product-form-modal');
const clientFormModal = document.getElementById('client-form-modal');
const galleryModal = document.getElementById('gallery-modal');
const deleteModal = document.getElementById('delete-modal');
const accountSettingsModal = document.getElementById('account-settings-modal');
const toastContainer = document.getElementById('toast-container');

// Document Ready
document.addEventListener('DOMContentLoaded', async () => {
  if (!adminState.token) {
    window.location.href = '/login';
    return;
  }

  const valid = await checkAuth();
  if (!valid) return;

  setupNavigationTabs();
  setupEventListeners();
  await loadDashboardData();
});

// Autenticación de Super-Admin
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    });
    if (!res.ok) {
      logout();
      return false;
    }
    const data = await res.json();
    if (data.success) {
      adminState.adminUser = data.user;
      const navUserEl = document.getElementById('admin-navbar-username');
      if (navUserEl && data.user && data.user.username) {
        navUserEl.textContent = data.user.username;
      }
      return true;
    }
    logout();
    return false;
  } catch (err) {
    logout();
    return false;
  }
}

function logout() {
  if (adminState.token) {
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    }).catch(() => {});
  }
  localStorage.removeItem('admin_token');
  window.location.href = '/login';
}

// Navegación por pestañas (Productos vs Clientes)
function setupNavigationTabs() {
  tabProductsBtn.addEventListener('click', () => switchTab('products'));
  tabClientsBtn.addEventListener('click', () => switchTab('clients'));
}

function switchTab(tab) {
  if (tab === 'products') {
    tabProductsBtn.classList.add('active');
    tabClientsBtn.classList.remove('active');
    viewProducts.style.display = 'block';
    viewClients.style.display = 'none';
  } else {
    tabProductsBtn.classList.remove('active');
    tabClientsBtn.classList.add('active');
    viewProducts.style.display = 'none';
    viewClients.style.display = 'block';
    renderClientsGrid();
  }
}

// Event Listeners Generales
function setupEventListeners() {
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Cambio de Catálogo Activo en barra superior
  adminActiveClientSelect.addEventListener('change', (e) => {
    adminState.activeClientId = e.target.value;
    localStorage.setItem('admin_active_client_id', adminState.activeClientId);
    updateActiveCatalogLink();
    loadStats();
    loadCategories();
    loadProducts();
    updateHeadings();
  });

  // Copiar Enlace Único del Catálogo Activo
  btnCopyActiveLink.addEventListener('click', copyActiveCatalogLink);

  // Botón Nuevo Producto
  document.getElementById('btn-new-product').addEventListener('click', () => {
    openProductForm('create');
  });

  // Botón Nuevo Cliente
  document.getElementById('btn-new-client').addEventListener('click', () => {
    openClientForm('create');
  });

  // Explorador de Storage
  document.getElementById('btn-view-gallery').addEventListener('click', () => {
    openGalleryModal(false, 'browse');
  });

  // Filtros de Productos
  let timer;
  searchAdminInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(loadProducts, 250);
  });
  filterAdminCategory.addEventListener('change', loadProducts);
  filterAdminStock.addEventListener('change', loadProducts);

  // Formularios
  document.getElementById('product-form').addEventListener('submit', handleProductFormSubmit);
  document.getElementById('client-form').addEventListener('submit', handleClientFormSubmit);

  // Modales Cierres
  document.getElementById('close-form-modal').addEventListener('click', closeProductForm);
  document.getElementById('cancel-form-btn').addEventListener('click', closeProductForm);
  document.getElementById('close-client-modal').addEventListener('click', closeClientForm);
  document.getElementById('cancel-client-btn').addEventListener('click', closeClientForm);
  document.getElementById('close-gallery-modal').addEventListener('click', () => galleryModal.classList.remove('active'));
  document.getElementById('close-delete-modal').addEventListener('click', closeDeleteModal);
  document.getElementById('cancel-delete-btn').addEventListener('click', closeDeleteModal);
  document.getElementById('confirm-delete-btn').addEventListener('click', executeDelete);

  // Modal de Credenciales de Cuenta Super-Admin
  const btnAccount = document.getElementById('btn-account-settings');
  if (btnAccount && accountSettingsModal) {
    btnAccount.addEventListener('click', openAccountSettingsModal);
    document.getElementById('close-account-modal').addEventListener('click', closeAccountSettingsModal);
    document.getElementById('cancel-account-btn').addEventListener('click', closeAccountSettingsModal);
    document.getElementById('account-settings-form').addEventListener('submit', handleAccountSettingsSubmit);
  }

  setupImageInputListeners();
  setupClientModalListeners();
  setupStorageExplorerListeners();
}

function openAccountSettingsModal() {
  const form = document.getElementById('account-settings-form');
  if (form) form.reset();
  const usernameInput = document.getElementById('acc-new-username');
  if (usernameInput && adminState.adminUser) {
    usernameInput.value = adminState.adminUser.username || '';
  }
  accountSettingsModal.classList.add('active');
}

function closeAccountSettingsModal() {
  if (accountSettingsModal) {
    accountSettingsModal.classList.remove('active');
  }
}

async function handleAccountSettingsSubmit(e) {
  e.preventDefault();
  const newUsername = document.getElementById('acc-new-username').value.trim();
  const newPassword = document.getElementById('acc-new-password').value;
  const confirmPassword = document.getElementById('acc-confirm-password').value;
  const currentPassword = document.getElementById('acc-current-password').value;
  const saveBtn = document.getElementById('save-account-btn');

  if (newUsername.length < 3 || /\s/.test(newUsername)) {
    showToast('El nombre de usuario debe tener al menos 3 caracteres y sin espacios.', 'error');
    return;
  }

  if (newPassword && newPassword.length < 6) {
    showToast('La nueva contraseña debe tener al menos 6 caracteres.', 'error');
    return;
  }

  if (newPassword && newPassword !== confirmPassword) {
    showToast('Las nuevas contraseñas no coinciden.', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

  try {
    const res = await fetch('/api/auth/credentials', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminState.token}`
      },
      body: JSON.stringify({
        currentPassword,
        newUsername,
        newPassword: newPassword || undefined
      })
    });
    const result = await res.json();

    if (res.ok && result.success) {
      if (result.token) {
        adminState.token = result.token;
        localStorage.setItem('admin_token', result.token);
      }
      if (result.user) {
        adminState.adminUser = result.user;
        const navUserEl = document.getElementById('admin-navbar-username');
        if (navUserEl) navUserEl.textContent = result.user.username;
      }
      closeAccountSettingsModal();
      showToast('¡Tus credenciales de Super-Administrador fueron actualizadas!');
    } else {
      showToast(result.error || 'No se pudieron actualizar las credenciales.', 'error');
    }
  } catch (err) {
    showToast('Error de conexión al actualizar credenciales.', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar Cambios';
  }
}

function setupImageInputListeners() {
  const fileInput = document.getElementById('prod-image-file');
  const urlInput = document.getElementById('prod-image-url');
  const preview = document.getElementById('image-preview');

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        preview.src = event.target.result;
        preview.style.display = 'block';
        document.getElementById('image-preview-placeholder').style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
  });

  urlInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      preview.src = val;
      preview.style.display = 'block';
      document.getElementById('image-preview-placeholder').style.display = 'none';
    }
  });

  document.getElementById('btn-pick-gallery').addEventListener('click', () => {
    openGalleryModal(true, 'product');
  });
}

function setupClientModalListeners() {
  const nameInput = document.getElementById('client-name');
  const slugInput = document.getElementById('client-slug');
  const preview = document.getElementById('client-link-preview');
  const colorPicker = document.getElementById('client-color-picker');
  const colorInput = document.getElementById('client-color');

  nameInput.addEventListener('input', () => {
    if (!adminState.activeEditingClientId) {
      const autoSlug = nameInput.value
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 -]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
      slugInput.value = autoSlug;
      preview.textContent = `${window.location.origin}/c/${autoSlug || 'tu-catalogo'}`;
    }
  });

  slugInput.addEventListener('input', () => {
    preview.textContent = `${window.location.origin}/c/${slugInput.value.trim() || 'tu-catalogo'}`;
  });

  colorPicker.addEventListener('input', (e) => {
    colorInput.value = e.target.value;
  });
  colorInput.addEventListener('input', (e) => {
    colorPicker.value = e.target.value;
  });

  // Listeners para Selector de Tipo de Moneda del Catálogo
  const currencyPresetSelect = document.getElementById('client-currency-preset');
  const customCurrencyGroup = document.getElementById('custom-currency-group');
  const currencySymbolInput = document.getElementById('client-currency-symbol');
  const currencyCodeInput = document.getElementById('client-currency-code');

  if (currencyPresetSelect) {
    currencyPresetSelect.addEventListener('change', () => {
      const val = currencyPresetSelect.value;
      if (val === 'CUSTOM') {
        customCurrencyGroup.style.display = 'block';
      } else {
        customCurrencyGroup.style.display = 'none';
        const parts = val.split('|');
        currencyCodeInput.value = parts[0] || 'USD';
        currencySymbolInput.value = parts[1] || '$';
      }
    });
  }

  // Listeners para Subida y Previsualización de Logotipo
  const logoFileInput = document.getElementById('client-logo-file');
  const logoUrlInput = document.getElementById('client-logo-url');
  const logoPreview = document.getElementById('client-logo-preview');
  const logoPlaceholder = document.getElementById('client-logo-placeholder');

  logoFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        logoPreview.src = event.target.result;
        logoPreview.style.display = 'block';
        logoPlaceholder.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
  });

  logoUrlInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      logoPreview.src = val;
      logoPreview.style.display = 'block';
      logoPlaceholder.style.display = 'none';
    } else {
      logoPreview.style.display = 'none';
      logoPlaceholder.style.display = 'inline';
    }
  });

  document.getElementById('btn-pick-client-logo').addEventListener('click', () => {
    openGalleryModal(true, 'client-logo');
  });

  // Listeners para Subida y Previsualización de Portada / Banner
  const coverFileInput = document.getElementById('client-cover-file');
  const coverUrlInput = document.getElementById('client-cover-url');
  const coverPreview = document.getElementById('client-cover-preview');
  const coverPlaceholder = document.getElementById('client-cover-placeholder');

  coverFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        coverPreview.src = event.target.result;
        coverPreview.style.display = 'block';
        coverPlaceholder.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
  });

  coverUrlInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      coverPreview.src = val;
      coverPreview.style.display = 'block';
      coverPlaceholder.style.display = 'none';
    } else {
      coverPreview.style.display = 'none';
      coverPlaceholder.style.display = 'inline';
    }
  });

  document.getElementById('btn-pick-client-cover').addEventListener('click', () => {
    openGalleryModal(true, 'client-cover');
  });
}

// Carga Inicial de Datos
async function loadDashboardData() {
  await Promise.all([loadClients(), loadLocalImages()]);
  await Promise.all([loadStats(), loadCategories(), loadProducts()]);
  updateActiveCatalogLink();
  updateHeadings();
}

// Cargar Clientes y popular dropdowns
async function loadClients() {
  try {
    const res = await fetch('/api/admin/clientes', {
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    });
    const result = await res.json();
    if (result.success) {
      adminState.clients = result.data;
      badgeTotalClients.textContent = result.data.length;

      // Actualizar select de clientes en la barra superior
      let optionsHtml = '<option value="all">🌐 Todos los Clientes (Vista Global)</option>';
      result.data.forEach(c => {
        optionsHtml += `<option value="${c.id}" ${String(c.id) === String(adminState.activeClientId) ? 'selected' : ''}>
          ${c.nombre} (${c.total_productos} prods)
        </option>`;
      });
      adminActiveClientSelect.innerHTML = optionsHtml;

      // Actualizar select de cliente en modal de producto
      const prodClientSelect = document.getElementById('prod-client-id');
      prodClientSelect.innerHTML = result.data.map(c => `
        <option value="${c.id}">${c.nombre} (${c.slug})</option>
      `).join('');

      renderClientsGrid();
    }
  } catch (err) {
    console.error('Error al cargar clientes:', err);
  }
}

// Renderizar Cuadrícula de Clientes y sus Enlaces Únicos
function renderClientsGrid() {
  if (adminState.clients.length === 0) {
    clientsGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem; background: #fff; border-radius: var(--radius-lg); border: 1px dashed var(--border-light);">
        <p style="color: var(--text-muted); font-size: 1rem;">No hay clientes registrados aún.</p>
        <button class="btn btn-primary" onclick="openClientForm('create')" style="margin-top: 1rem;">
          + Generar Primer Catálogo
        </button>
      </div>
    `;
    return;
  }

  clientsGrid.innerHTML = adminState.clients.map(c => {
    const fullUniqueUrl = `${window.location.origin}${c.enlace_publico}`;
    const coverStyle = c.portada_url ? `background: url('${c.portada_url}') center/cover;` : 'background: linear-gradient(135deg, #1e1b4b, #4338ca);';

    return `
      <div class="client-card">
        <!-- Banner de Portada y Logo del Cliente en Dashboard -->
        <div style="height: 85px; border-radius: var(--radius-md) var(--radius-md) 0 0; margin: -1.5rem -1.5rem 0.5rem -1.5rem; position: relative; overflow: hidden; ${coverStyle}">
          <div style="position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.65) 100%);"></div>
          <div style="position: absolute; bottom: 8px; left: 1rem; display: flex; align-items: center; gap: 0.625rem; z-index: 2;">
            <div style="width: 44px; height: 44px; border-radius: 50%; border: 2px solid #fff; overflow: hidden; background: #fff; box-shadow: var(--shadow-sm); display: flex; align-items: center; justify-content: center;">
              <img src="${c.logo_url || 'https://placehold.co/100x100/4f46e5/ffffff?text=L'}" alt="Logo" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.src='https://placehold.co/100x100/4f46e5/ffffff?text=L';" />
            </div>
            <div style="color: #fff; font-weight: 800; font-size: 1.05rem; text-shadow: 0 1px 3px rgba(0,0,0,0.7);">${c.nombre}</div>
          </div>
          <span class="badge ${c.activo ? 'badge-stock-in' : 'badge-stock-out'}" style="position: absolute; top: 8px; right: 8px; z-index: 2;">
            ${c.activo ? 'Activo' : 'Pausado'}
          </span>
        </div>

        <p style="font-size: 0.8125rem; color: var(--text-muted);">${c.descripcion || 'Sin descripción'}</p>

        <!-- Caja de Enlace Único Estático -->
        <div class="client-link-box">
          <div class="client-link-text" title="${fullUniqueUrl}">
            🔗 <a href="${c.enlace_publico}" target="_blank" style="color: var(--primary); font-weight: 600;">${c.enlace_publico}</a>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${fullUniqueUrl}')" title="Copiar enlace público completo">
            Copiar
          </button>
        </div>

        <!-- Datos de Contacto y Métricas -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.8125rem; background: var(--bg-surface-secondary); padding: 0.75rem; border-radius: var(--radius-md);">
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">WhatsApp Pedidos:</span>
            <strong>${c.telefono_whatsapp || 'No asignado'}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Moneda Catálogo:</span>
            <span class="badge" style="background: #e0e7ff; color: #3730a3; font-weight: 700;">${c.moneda_codigo || 'USD'} (${c.moneda_simbolo || '$'})</span>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Total Productos:</span>
            <strong>${c.total_productos} (${c.total_unidades} unid.)</strong>
          </div>
          <div>
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Valor Catálogo:</span>
            <strong style="color: var(--primary);">${c.moneda_simbolo || '$'}${c.valor_inventario.toFixed(2)}</strong>
          </div>
          <div style="grid-column: 1 / -1;">
            <span style="color: var(--text-muted); display: block; font-size: 0.75rem;">Slug Único:</span>
            <code>${c.slug}</code>
          </div>
        </div>

        <!-- Acciones del Catálogo del Cliente -->
        <div style="display: flex; gap: 0.5rem; margin-top: auto; padding-top: 0.5rem; border-top: 1px solid var(--border-light);">
          <button class="btn btn-primary btn-sm" style="flex: 1;" onclick="manageClientCatalog(${c.id})">
            📦 Gestionar Productos
          </button>
          <button class="btn btn-secondary btn-sm" onclick="editClient(${c.id})" title="Editar datos">
            ✏️
          </button>
          <button class="btn btn-outline btn-sm" onclick="confirmDelete('client', ${c.id}, '${c.nombre}')" style="color: #ef4444;" title="Eliminar cliente y catálogo">
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Acceso directo a gestionar productos de un cliente específico
function manageClientCatalog(clientId) {
  adminState.activeClientId = String(clientId);
  localStorage.setItem('admin_active_client_id', adminState.activeClientId);
  adminActiveClientSelect.value = adminState.activeClientId;

  switchTab('products');
  updateActiveCatalogLink();
  updateHeadings();
  loadStats();
  loadCategories();
  loadProducts();
}

// Cargar KPIs
async function loadStats() {
  try {
    const params = new URLSearchParams();
    if (adminState.activeClientId !== 'all') {
      params.append('cliente_id', adminState.activeClientId);
    }

    const res = await fetch(`/api/admin/stats?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    });
    const result = await res.json();
    if (result.success) {
      adminState.stats = result.data;
      kpiTotalProducts.textContent = result.data.total_productos;

      let symbol = '$';
      if (adminState.activeClientId !== 'all') {
        const activeClient = adminState.clients.find(c => String(c.id) === String(adminState.activeClientId));
        if (activeClient && activeClient.moneda_simbolo) symbol = activeClient.moneda_simbolo;
      }
      kpiTotalValue.textContent = `${symbol}${result.data.valor_total_inventario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      kpiLowStock.textContent = result.data.stock_bajo;
      kpiOutOfStock.textContent = result.data.agotados;
    }
  } catch (err) {
    console.error('Error al cargar KPIs:', err);
  }
}

// Cargar Categorías
async function loadCategories() {
  try {
    const params = new URLSearchParams();
    if (adminState.activeClientId !== 'all') {
      params.append('cliente_id', adminState.activeClientId);
    }

    const res = await fetch(`/api/categories?${params.toString()}`);
    const result = await res.json();
    if (result.success) {
      adminState.categories = result.data;

      let filterHtml = '<option value="all">Todas las Categorías</option>';
      result.data.forEach(c => {
        filterHtml += `<option value="${c.categoria}">${c.categoria} (${c.count})</option>`;
      });
      filterAdminCategory.innerHTML = filterHtml;

      const datalist = document.getElementById('category-options');
      datalist.innerHTML = result.data.map(c => `<option value="${c.categoria}">`).join('');
    }
  } catch (err) {
    console.error('Error al cargar categorías:', err);
  }
}

// Cargar Productos
async function loadProducts() {
  try {
    adminTableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          Actualizando inventario...
        </td>
      </tr>
    `;

    const params = new URLSearchParams();
    if (adminState.activeClientId !== 'all') {
      params.append('cliente_id', adminState.activeClientId);
    }

    const query = searchAdminInput.value.trim();
    const cat = filterAdminCategory.value;
    const stockFilter = filterAdminStock.value;

    if (query) params.append('search', query);
    if (cat !== 'all') params.append('categoria', cat);
    if (stockFilter === 'in_stock') params.append('inStock', 'true');
    params.append('sortBy', 'id');
    params.append('sortOrder', 'ASC');

    const res = await fetch(`/api/products?${params.toString()}`);
    const result = await res.json();

    if (result.success) {
      let filtered = result.data;
      if (stockFilter === 'low_stock') {
        filtered = filtered.filter(p => p.inventario <= 5 && p.inventario > 0);
      } else if (stockFilter === 'out_of_stock') {
        filtered = filtered.filter(p => p.inventario === 0);
      }

      adminState.products = filtered;
      renderAdminTable(filtered);
    }
  } catch (err) {
    console.error('Error al cargar productos:', err);
  }
}

// Renderizar Tabla Administrativa
function renderAdminTable(products) {
  if (products.length === 0) {
    adminTableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 3rem; color: var(--text-muted);">
          No se encontraron productos registrados para este catálogo.
        </td>
      </tr>
    `;
    return;
  }

  adminTableBody.innerHTML = products.map(p => {
    let stockBadge = '<span class="badge badge-stock-in">Normal</span>';
    if (p.inventario === 0) {
      stockBadge = '<span class="badge badge-stock-out">Agotado</span>';
    } else if (p.inventario <= 5) {
      stockBadge = '<span class="badge badge-stock-low">Stock Bajo</span>';
    }

    const prodClient = adminState.clients.find(c => c.id === p.cliente_id);
    const prodSymbol = (prodClient && prodClient.moneda_simbolo) || '$';

    return `
      <tr>
        <td style="font-weight: 700; color: var(--text-muted);">#${p.id}</td>
        <td>
          <img 
            src="${p.imagen_url}" 
            alt="${p.nombre}" 
            class="table-thumb" 
            loading="lazy"
            onerror="this.src='https://placehold.co/100x100/e2e8f0/475569?text=IMG';"
          />
        </td>
        <td>
          <div style="font-weight: 700; color: var(--text-main);">${p.nombre}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${p.descripcion}
          </div>
        </td>
        <td>
          <span style="font-weight: 600; color: var(--primary); font-size: 0.8125rem;">
            ${p.cliente_nombre || 'General'}
          </span>
        </td>
        <td>
          <span class="badge badge-category">${p.categoria}</span>
        </td>
        <td style="font-weight: 700; font-size: 0.9375rem;">
          ${prodSymbol}${Number(p.precio).toFixed(2)}
        </td>
        <td>
          <div class="stock-stepper">
            <button type="button" onclick="quickStockAdjust(${p.id}, -1)" title="Reducir 1 unidad">-</button>
            <span style="font-weight: 800; min-width: 2rem; text-align: center;">${p.inventario}</span>
            <button type="button" onclick="quickStockAdjust(${p.id}, 1)" title="Añadir 1 unidad">+</button>
          </div>
          <div style="margin-top: 4px;">${stockBadge}</div>
        </td>
        <td style="white-space: nowrap; text-align: center;">
          <div style="display: flex; gap: 0.375rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm" onclick="editProduct(${p.id})" title="Editar producto">
              ✏️
            </button>
            <button class="btn btn-outline btn-sm" onclick="confirmDelete('product', ${p.id}, '${p.nombre}')" style="color: #ef4444; border-color: #fecaca;" title="Eliminar producto">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Ajuste Rápido de Stock
async function quickStockAdjust(id, delta) {
  try {
    const res = await fetch(`/api/products/${id}/stock`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminState.token}`
      },
      body: JSON.stringify({ delta })
    });

    const result = await res.json();
    if (result.success) {
      showToast(`Stock actualizado: ${result.data.nombre} (${result.data.inventario} unid.).`);
      loadProducts();
      loadStats();
    } else {
      showToast(result.error || 'Error al ajustar el inventario.', 'error');
    }
  } catch (err) {
    showToast('Error de red al actualizar inventario.', 'error');
  }
}

// Actualizar enlaces del catálogo activo en la barra superior
function updateActiveCatalogLink() {
  if (adminState.activeClientId === 'all') {
    btnViewActiveCatalog.href = '/';
    btnCopyActiveLink.style.display = 'none';
  } else {
    const client = adminState.clients.find(c => String(c.id) === String(adminState.activeClientId));
    if (client) {
      btnViewActiveCatalog.href = client.enlace_publico;
      btnCopyActiveLink.style.display = 'inline-flex';
    } else {
      btnViewActiveCatalog.href = '/';
      btnCopyActiveLink.style.display = 'none';
    }
  }
}

function updateHeadings() {
  if (adminState.activeClientId === 'all') {
    catalogHeadingTitle.textContent = 'Productos de Todos los Clientes (Vista Global)';
    catalogHeadingSubtitle.textContent = 'Visualizando la totalidad de ítems e inventarios del sistema.';
  } else {
    const client = adminState.clients.find(c => String(c.id) === String(adminState.activeClientId));
    if (client) {
      catalogHeadingTitle.textContent = `Catálogo de: ${client.nombre}`;
      catalogHeadingSubtitle.textContent = `Enlace único público: ${window.location.origin}${client.enlace_publico}`;
    }
  }
}

function copyActiveCatalogLink() {
  const client = adminState.clients.find(c => String(c.id) === String(adminState.activeClientId));
  if (client) {
    const fullUrl = `${window.location.origin}${client.enlace_publico}`;
    copyToClipboard(fullUrl);
  }
}

// Modal Producto (Crear / Editar)
function openProductForm(mode, product = null) {
  if (mode === 'create' && adminState.clients.length === 0) {
    showToast('Primero registra la tienda/cliente para poder agregarle productos.', 'error');
    switchTab('clients');
    openClientForm('create');
    return;
  }

  const form = document.getElementById('product-form');
  form.reset();

  const modalTitle = document.getElementById('form-modal-title');
  const preview = document.getElementById('image-preview');
  const placeholder = document.getElementById('image-preview-placeholder');
  const prodClientSelect = document.getElementById('prod-client-id');

  // Si hay un cliente activo seleccionado, preseleccionarlo en el formulario
  if (adminState.activeClientId !== 'all') {
    prodClientSelect.value = adminState.activeClientId;
  }

  if (mode === 'edit' && product) {
    adminState.activeEditingProductId = product.id;
    modalTitle.textContent = `Editar Producto #${product.id}`;
    document.getElementById('prod-id').value = product.id;
    prodClientSelect.value = product.cliente_id;
    document.getElementById('prod-name').value = product.nombre;
    document.getElementById('prod-category').value = product.categoria;
    document.getElementById('prod-price').value = product.precio;
    document.getElementById('prod-stock').value = product.inventario;
    document.getElementById('prod-description').value = product.descripcion;
    document.getElementById('prod-image-url').value = product.imagen_url;

    if (product.imagen_url) {
      preview.src = product.imagen_url;
      preview.style.display = 'block';
      placeholder.style.display = 'none';
    } else {
      preview.style.display = 'none';
      placeholder.style.display = 'flex';
    }
  } else {
    adminState.activeEditingProductId = null;
    modalTitle.textContent = 'Registrar Nuevo Producto';
    document.getElementById('prod-id').value = '';
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
  }

  productFormModal.classList.add('active');
}

function closeProductForm() {
  productFormModal.classList.remove('active');
  adminState.activeEditingProductId = null;
}

function editProduct(id) {
  const p = adminState.products.find(item => item.id === id);
  if (p) openProductForm('edit', p);
}

async function handleProductFormSubmit(e) {
  e.preventDefault();
  const id = adminState.activeEditingProductId;
  const isEditing = Boolean(id);

  const fileInput = document.getElementById('prod-image-file');
  const hasFile = fileInput.files && fileInput.files.length > 0;

  let formData;
  let headers = { 'Authorization': `Bearer ${adminState.token}` };

  if (hasFile) {
    formData = new FormData();
    formData.append('cliente_id', document.getElementById('prod-client-id').value);
    formData.append('nombre', document.getElementById('prod-name').value);
    formData.append('categoria', document.getElementById('prod-category').value);
    formData.append('precio', document.getElementById('prod-price').value);
    formData.append('inventario', document.getElementById('prod-stock').value);
    formData.append('descripcion', document.getElementById('prod-description').value);
    formData.append('imagen', fileInput.files[0]);
  } else {
    headers['Content-Type'] = 'application/json';
    formData = JSON.stringify({
      cliente_id: parseInt(document.getElementById('prod-client-id').value, 10),
      nombre: document.getElementById('prod-name').value,
      categoria: document.getElementById('prod-category').value,
      precio: parseFloat(document.getElementById('prod-price').value),
      inventario: parseInt(document.getElementById('prod-stock').value, 10),
      descripcion: document.getElementById('prod-description').value,
      imagen_url: document.getElementById('prod-image-url').value
    });
  }

  const endpoint = isEditing ? `/api/products/${id}` : '/api/products';
  const method = isEditing ? 'PUT' : 'POST';

  try {
    const res = await fetch(endpoint, { method, headers, body: formData });
    const result = await res.json();

    if (result.success) {
      showToast(isEditing ? 'Producto actualizado con éxito.' : 'Producto creado exitosamente.');
      closeProductForm();
      await loadClients();
      loadProducts();
      loadStats();
      loadCategories();
    } else {
      showToast(result.error || 'Error al guardar producto.', 'error');
    }
  } catch (err) {
    showToast('Error de conexión al guardar producto.', 'error');
  }
}

// Modal Cliente (Crear / Editar)
function openClientForm(mode, client = null) {
  const form = document.getElementById('client-form');
  form.reset();

  const title = document.getElementById('client-modal-title');
  const preview = document.getElementById('client-link-preview');
  const logoPreview = document.getElementById('client-logo-preview');
  const logoPlaceholder = document.getElementById('client-logo-placeholder');
  const coverPreview = document.getElementById('client-cover-preview');
  const coverPlaceholder = document.getElementById('client-cover-placeholder');
  const currencyPresetSelect = document.getElementById('client-currency-preset');
  const customCurrencyGroup = document.getElementById('custom-currency-group');
  const currencySymbolInput = document.getElementById('client-currency-symbol');
  const currencyCodeInput = document.getElementById('client-currency-code');

  if (mode === 'edit' && client) {
    adminState.activeEditingClientId = client.id;
    title.textContent = `Editar Catálogo de: ${client.nombre}`;
    document.getElementById('client-form-id').value = client.id;
    document.getElementById('client-name').value = client.nombre;
    document.getElementById('client-slug').value = client.slug;
    document.getElementById('client-whatsapp').value = client.telefono_whatsapp || '';
    document.getElementById('client-email').value = client.email || '';
    document.getElementById('client-desc').value = client.descripcion || '';
    document.getElementById('client-color').value = client.color_primario || '#4f46e5';
    document.getElementById('client-color-picker').value = client.color_primario || '#4f46e5';
    document.getElementById('client-logo-url').value = client.logo_url || '';
    document.getElementById('client-cover-url').value = client.portada_url || '';

    // Configuración de moneda
    const clientCode = client.moneda_codigo || 'USD';
    const clientSymbol = client.moneda_simbolo || '$';
    const presetKey = `${clientCode}|${clientSymbol}`;
    const matchedOption = Array.from(currencyPresetSelect.options).find(opt => opt.value === presetKey);

    if (matchedOption) {
      currencyPresetSelect.value = presetKey;
      customCurrencyGroup.style.display = 'none';
      currencySymbolInput.value = clientSymbol;
      currencyCodeInput.value = clientCode;
    } else {
      currencyPresetSelect.value = 'CUSTOM';
      customCurrencyGroup.style.display = 'block';
      currencySymbolInput.value = clientSymbol;
      currencyCodeInput.value = clientCode;
    }

    if (client.logo_url && client.logo_url.trim() !== '') {
      logoPreview.src = client.logo_url;
      logoPreview.style.display = 'block';
      logoPlaceholder.style.display = 'none';
    } else {
      logoPreview.style.display = 'none';
      logoPlaceholder.style.display = 'inline';
    }

    if (client.portada_url && client.portada_url.trim() !== '') {
      coverPreview.src = client.portada_url;
      coverPreview.style.display = 'block';
      coverPlaceholder.style.display = 'none';
    } else {
      coverPreview.style.display = 'none';
      coverPlaceholder.style.display = 'inline';
    }

    preview.textContent = `${window.location.origin}/c/${client.slug}`;
  } else {
    adminState.activeEditingClientId = null;
    title.textContent = 'Generar Nuevo Catálogo de Cliente';
    document.getElementById('client-form-id').value = '';
    document.getElementById('client-color').value = '#4f46e5';
    document.getElementById('client-color-picker').value = '#4f46e5';
    document.getElementById('client-logo-url').value = '';
    document.getElementById('client-cover-url').value = '';
    currencyPresetSelect.value = 'USD|$';
    customCurrencyGroup.style.display = 'none';
    currencySymbolInput.value = '$';
    currencyCodeInput.value = 'USD';
    logoPreview.style.display = 'none';
    logoPlaceholder.style.display = 'inline';
    coverPreview.style.display = 'none';
    coverPlaceholder.style.display = 'inline';
    preview.textContent = `${window.location.origin}/c/tu-catalogo`;
  }

  clientFormModal.classList.add('active');
}

function closeClientForm() {
  clientFormModal.classList.remove('active');
  adminState.activeEditingClientId = null;
}

function editClient(id) {
  const c = adminState.clients.find(item => item.id === id);
  if (c) openClientForm('edit', c);
}

async function handleClientFormSubmit(e) {
  e.preventDefault();
  const id = adminState.activeEditingClientId;
  const isEditing = Boolean(id);

  const logoFile = document.getElementById('client-logo-file').files[0];
  const coverFile = document.getElementById('client-cover-file').files[0];

  const currencyPreset = document.getElementById('client-currency-preset').value;
  let moneda_codigo = 'USD';
  let moneda_simbolo = '$';

  if (currencyPreset === 'CUSTOM') {
    moneda_simbolo = document.getElementById('client-currency-symbol').value.trim() || '$';
    moneda_codigo = document.getElementById('client-currency-code').value.trim().toUpperCase() || 'USD';
  } else {
    const parts = currencyPreset.split('|');
    moneda_codigo = parts[0] || 'USD';
    moneda_simbolo = parts[1] || '$';
  }

  let body;
  let headers = { 'Authorization': `Bearer ${adminState.token}` };

  if (logoFile || coverFile) {
    body = new FormData();
    body.append('nombre', document.getElementById('client-name').value.trim());
    body.append('slug', document.getElementById('client-slug').value.trim());
    body.append('telefono_whatsapp', document.getElementById('client-whatsapp').value.trim());
    body.append('email', document.getElementById('client-email').value.trim());
    body.append('descripcion', document.getElementById('client-desc').value.trim());
    body.append('color_primario', document.getElementById('client-color').value.trim());
    body.append('moneda_simbolo', moneda_simbolo);
    body.append('moneda_codigo', moneda_codigo);
    body.append('logo_url', document.getElementById('client-logo-url').value.trim());
    body.append('portada_url', document.getElementById('client-cover-url').value.trim());
    if (logoFile) body.append('logo', logoFile);
    if (coverFile) body.append('portada', coverFile);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      nombre: document.getElementById('client-name').value.trim(),
      slug: document.getElementById('client-slug').value.trim(),
      telefono_whatsapp: document.getElementById('client-whatsapp').value.trim(),
      email: document.getElementById('client-email').value.trim(),
      descripcion: document.getElementById('client-desc').value.trim(),
      color_primario: document.getElementById('client-color').value.trim(),
      moneda_simbolo,
      moneda_codigo,
      logo_url: document.getElementById('client-logo-url').value.trim(),
      portada_url: document.getElementById('client-cover-url').value.trim()
    });
  }

  const endpoint = isEditing ? `/api/admin/clientes/${id}` : '/api/admin/clientes';
  const method = isEditing ? 'PUT' : 'POST';

  try {
    const res = await fetch(endpoint, {
      method,
      headers,
      body
    });

    const result = await res.json();
    if (result.success) {
      showToast(isEditing ? 'Cliente y diseño de catálogo actualizados.' : `¡Catálogo '${result.data.nombre}' generado con éxito!`);
      closeClientForm();
      await loadClients();
      updateActiveCatalogLink();
    } else {
      showToast(result.error || 'Error al guardar cliente.', 'error');
    }
  } catch (err) {
    showToast('Error de red al guardar cliente.', 'error');
  }
}

// Modal de Confirmación de Eliminación (Unificado para Producto o Cliente)
function confirmDelete(type, id, title) {
  adminState.deleteTarget = { type, id };
  document.getElementById('delete-modal-title').textContent = type === 'client' ? 'Eliminar Catálogo de Cliente' : 'Eliminar Producto';
  document.getElementById('delete-item-heading').textContent = type === 'client' 
    ? '¿Estás seguro de eliminar este cliente y todo su catálogo?'
    : '¿Estás seguro de eliminar este producto del catálogo?';
  document.getElementById('delete-item-desc').textContent = type === 'client'
    ? 'Se eliminará el comercio y todos los productos vinculados a este enlace único.'
    : 'Esta acción removerá el ítem de forma permanente.';
  document.getElementById('delete-item-info').textContent = `${type.toUpperCase()} #${id}: ${title}`;

  deleteModal.classList.add('active');
}

function closeDeleteModal() {
  deleteModal.classList.remove('active');
  adminState.deleteTarget = null;
}

async function executeDelete() {
  if (!adminState.deleteTarget) return;
  const { type, id } = adminState.deleteTarget;

  const endpoint = type === 'client' ? `/api/admin/clientes/${id}` : `/api/products/${id}`;

  try {
    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    });
    const result = await res.json();

    if (result.success) {
      showToast(type === 'client' ? 'Cliente y catálogo eliminados.' : 'Producto eliminado.');
      closeDeleteModal();
      await loadClients();
      loadProducts();
      loadStats();
      loadCategories();
    } else {
      showToast(result.error || 'No se pudo eliminar.', 'error');
    }
  } catch (err) {
    showToast('Error de red al eliminar.', 'error');
  }
}

// ==========================================================
// EXPLORADOR DE CARPETAS E IMÁGENES EN SUPABASE STORAGE
// ==========================================================

function setupStorageExplorerListeners() {
  const upBtn = document.getElementById('storage-up-btn');
  const refreshBtn = document.getElementById('storage-refresh-btn');
  const searchInput = document.getElementById('storage-search-input');
  const bucketSelect = document.getElementById('storage-bucket-select');

  if (upBtn) {
    upBtn.addEventListener('click', () => {
      const current = adminState.storage.prefix || '';
      if (!current) return;
      const parent = current.includes('/') ? current.substring(0, current.lastIndexOf('/')) : '';
      loadStorageDirectory(parent);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadStorageDirectory(adminState.storage.prefix, adminState.storage.bucket);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      adminState.storage.searchQuery = e.target.value.trim();
      renderStorageExplorer();
    });
  }

  if (bucketSelect) {
    bucketSelect.addEventListener('change', (e) => {
      adminState.storage.bucket = e.target.value;
      adminState.storage.prefix = '';
      loadStorageDirectory('', e.target.value);
    });
  }
}

async function loadLocalImages() {
  try {
    const res = await fetch('/api/admin/storage?prefix=', {
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    });
    const result = await res.json();
    if (result.success) {
      adminState.storage.bucket = result.bucket || 'productos';
      adminState.storage.buckets = result.buckets || [];
      adminState.storage.rootFolders = result.rootFolders || [];
    }
  } catch (err) {}
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSuggestedStoreFolderName() {
  let clientObj = null;
  if (adminState.galleryTarget === 'product') {
    const selectedId = document.getElementById('prod-client-id')?.value;
    clientObj = adminState.clients.find((c) => String(c.id) === String(selectedId));
  } else if (adminState.galleryTarget === 'client-logo' || adminState.galleryTarget === 'client-cover') {
    const formName = document.getElementById('client-name')?.value?.trim();
    const formSlug = document.getElementById('client-slug')?.value?.trim();
    if (formName || formSlug) {
      clientObj = { nombre: formName || '', slug: formSlug || '' };
    }
  } else if (adminState.activeClientId !== 'all') {
    clientObj = adminState.clients.find((c) => String(c.id) === String(adminState.activeClientId));
  }

  if (!clientObj) return null;

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

  const targetName = norm(clientObj.nombre);
  const targetSlug = norm(clientObj.slug);

  const match = (adminState.storage.rootFolders || []).find((f) => {
    const fn = norm(f.name);
    return fn && (fn === targetName || fn === targetSlug || targetName.includes(fn) || fn.includes(targetName));
  });

  return match ? match.path : null;
}

async function openGalleryModal(selectMode = false, target = 'product') {
  adminState.galleryTarget = target;
  adminState.storage.selectMode = Boolean(selectMode);
  adminState.storage.searchQuery = '';

  const searchInput = document.getElementById('storage-search-input');
  if (searchInput) searchInput.value = '';

  const titleEl = document.getElementById('gallery-modal-title');
  if (titleEl) {
    if (selectMode && target === 'product') {
      titleEl.textContent = '🗂️ Seleccionar Imagen del Producto (Storage)';
    } else if (selectMode && target === 'client-logo') {
      titleEl.textContent = '🗂️ Seleccionar Logotipo desde Storage';
    } else if (selectMode && target === 'client-cover') {
      titleEl.textContent = '🗂️ Seleccionar Foto de Portada desde Storage';
    } else {
      titleEl.textContent = '🗂️ Explorador de Carpetas e Imágenes en Storage';
    }
  }

  galleryModal.classList.add('active');
  await loadStorageDirectory(adminState.storage.prefix, adminState.storage.bucket);
}

async function loadStorageDirectory(prefix = '', bucket = adminState.storage.bucket) {
  const container = document.getElementById('gallery-grid');
  const statusBar = document.getElementById('storage-status-bar');
  adminState.storage.loading = true;

  if (container) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        ⏳ Cargando carpetas e imágenes desde Supabase Storage...
      </div>
    `;
  }
  if (statusBar) statusBar.textContent = '';

  try {
    const params = new URLSearchParams({
      bucket: bucket || 'productos',
      prefix: prefix || ''
    });

    const res = await fetch(`/api/admin/storage?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${adminState.token}` }
    });
    const result = await res.json();

    if (!res.ok || !result.success) {
      throw new Error(result.error || 'No se pudo consultar Supabase Storage.');
    }

    adminState.storage.bucket = result.bucket || 'productos';
    adminState.storage.buckets = result.buckets || [];
    adminState.storage.prefix = result.prefix || '';
    adminState.storage.breadcrumbs = result.breadcrumbs || [];
    adminState.storage.rootFolders = result.rootFolders || [];
    adminState.storage.folders = result.folders || [];
    adminState.storage.files = result.files || [];
    adminState.localImages = result.files || [];

    renderStorageExplorer();
  } catch (err) {
    if (container) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 2.5rem 1rem; color: #ef4444;">
          ⚠️ ${escapeHtml(err.message || 'Error al cargar Storage')}
        </div>
      `;
    }
  } finally {
    adminState.storage.loading = false;
  }
}

function getCurrentlySelectedUrlForTarget() {
  if (adminState.galleryTarget === 'client-logo') {
    return document.getElementById('client-logo-url')?.value?.trim() || '';
  }
  if (adminState.galleryTarget === 'client-cover') {
    return document.getElementById('client-cover-url')?.value?.trim() || '';
  }
  if (adminState.galleryTarget === 'product') {
    return document.getElementById('prod-image-url')?.value?.trim() || '';
  }
  return '';
}

function renderStorageExplorer() {
  const { bucket, buckets, prefix, breadcrumbs, rootFolders, folders, files, searchQuery, selectMode } = adminState.storage;
  const upBtn = document.getElementById('storage-up-btn');
  const crumbsEl = document.getElementById('storage-breadcrumbs');
  const quickFoldersEl = document.getElementById('storage-quick-folders');
  const bucketSelect = document.getElementById('storage-bucket-select');
  const statusBar = document.getElementById('storage-status-bar');
  const container = document.getElementById('gallery-grid');

  // 1. Botón Volver
  if (upBtn) {
    upBtn.style.display = prefix ? 'inline-flex' : 'none';
  }

  // 2. Selector de Bucket (visible solo si hay más de 1 bucket)
  if (bucketSelect) {
    if (buckets && buckets.length > 1) {
      bucketSelect.style.display = 'inline-block';
      bucketSelect.innerHTML = buckets
        .map((b) => `<option value="${escapeHtml(b.name)}" ${b.name === bucket ? 'selected' : ''}>🗄️ ${escapeHtml(b.name)}</option>`)
        .join('');
    } else {
      bucketSelect.style.display = 'none';
    }
  }

  // 3. Breadcrumbs interactivos
  if (crumbsEl) {
    crumbsEl.innerHTML = '';
    (breadcrumbs || []).forEach((crumb, idx) => {
      if (idx > 0) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.color = 'var(--text-subtle)';
        sep.style.fontWeight = '700';
        crumbsEl.appendChild(sep);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      const isLast = idx === breadcrumbs.length - 1;
      btn.className = `storage-crumb-btn ${isLast ? 'active' : ''}`;
      btn.textContent = idx === 0 ? `🏠 ${crumb.label}` : `📁 ${crumb.label}`;
      btn.addEventListener('click', () => {
        if (!isLast) loadStorageDirectory(crumb.prefix);
      });
      crumbsEl.appendChild(btn);
    });
  }

  // 4. Barra rápida de carpetas por tienda (1 clic para saltar entre tiendas)
  const suggestedFolder = getSuggestedStoreFolderName();
  if (quickFoldersEl) {
    if (rootFolders && rootFolders.length > 0) {
      quickFoldersEl.style.display = 'flex';
      quickFoldersEl.innerHTML = '';

      const label = document.createElement('span');
      label.textContent = 'Tiendas / Carpetas:';
      label.style.fontSize = '0.78rem';
      label.style.fontWeight = '700';
      label.style.color = 'var(--text-muted)';
      quickFoldersEl.appendChild(label);

      const allPill = document.createElement('button');
      allPill.type = 'button';
      allPill.className = `storage-folder-pill ${prefix === '' ? 'active' : ''}`;
      allPill.textContent = '🏠 Todas';
      allPill.addEventListener('click', () => loadStorageDirectory(''));
      quickFoldersEl.appendChild(allPill);

      rootFolders.forEach((rf) => {
        const isActive = prefix === rf.path || prefix.startsWith(`${rf.path}/`);
        const isSuggested = suggestedFolder && suggestedFolder === rf.path;
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `storage-folder-pill ${isActive ? 'active' : ''}`;
        pill.textContent = `${isSuggested ? '⭐ ' : '📁 '}${rf.name}`;
        pill.addEventListener('click', () => loadStorageDirectory(rf.path));
        quickFoldersEl.appendChild(pill);
      });
    } else {
      quickFoldersEl.style.display = 'none';
    }
  }

  // 5. Filtrado local por búsqueda dentro del nivel actual
  const q = (searchQuery || '').toLowerCase();
  const visibleFolders = q
    ? folders.filter((f) => f.name.toLowerCase().includes(q))
    : folders;
  const visibleFiles = q
    ? files.filter((f) => f.name.toLowerCase().includes(q))
    : files;

  // 6. Barra de estado descriptiva
  if (statusBar) {
    if (!prefix) {
      statusBar.textContent =
        visibleFolders.length > 0 && visibleFiles.length === 0
          ? `Selecciona una carpeta de tienda para ver sus productos (${visibleFolders.length} carpeta${visibleFolders.length === 1 ? '' : 's'} disponible${visibleFolders.length === 1 ? '' : 's'}).`
          : `Mostrando raíz del bucket '${bucket}': ${visibleFolders.length} carpeta(s) y ${visibleFiles.length} imagen(es).`;
    } else {
      statusBar.textContent = `📂 Carpeta actual: ${prefix} — ${visibleFolders.length > 0 ? `${visibleFolders.length} subcarpeta(s), ` : ''}${visibleFiles.length} imagen${visibleFiles.length === 1 ? '' : 'es'} encontrada${visibleFiles.length === 1 ? '' : 's'}.`;
    }
  }

  // 7. Renderizado de Tarjetas de Carpetas + Tarjetas de Imágenes
  if (!container) return;
  container.innerHTML = '';

  if (visibleFolders.length === 0 && visibleFiles.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem 1rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); border: 1px dashed var(--border-light); color: var(--text-muted);">
        <div style="font-size: 2.25rem; margin-bottom: 0.5rem;">📭</div>
        <div style="font-weight: 700; color: var(--text-main); margin-bottom: 0.25rem;">
          ${q ? 'No hay coincidencias con tu búsqueda en esta carpeta' : 'Esta carpeta aún no tiene imágenes'}
        </div>
        <div style="font-size: 0.8125rem;">
          ${prefix ? `Sube imágenes dentro de "${escapeHtml(prefix)}" en Supabase Storage y pulsa Actualizar.` : 'Crea carpetas por tienda o sube imágenes en el bucket de Supabase Storage.'}
        </div>
      </div>
    `;
    return;
  }

  // Renderizar carpetas primero
  visibleFolders.forEach((folder) => {
    const isSuggested = suggestedFolder && suggestedFolder === folder.path;
    const card = document.createElement('div');
    card.className = 'storage-folder-card';
    if (isSuggested) {
      card.style.borderColor = 'var(--primary)';
      card.style.background = '#eef2ff';
    }

    card.innerHTML = `
      <div style="font-size: 2.6rem; line-height: 1;">📁</div>
      <div style="font-weight: 800; font-size: 0.95rem; color: var(--text-main); word-break: break-word;">
        ${escapeHtml(folder.name)}
      </div>
      ${
        isSuggested
          ? '<span class="badge" style="background: var(--primary); color: #fff; font-size: 0.68rem;">⭐ Tienda seleccionada</span>'
          : '<span style="font-size: 0.75rem; color: var(--primary); font-weight: 600;">Abrir carpeta →</span>'
      }
    `;

    card.addEventListener('click', () => {
      loadStorageDirectory(folder.path);
    });

    container.appendChild(card);
  });

  // Renderizar archivos de imagen
  const currentSelectedUrl = getCurrentlySelectedUrlForTarget();

  visibleFiles.forEach((img) => {
    const isSelected = currentSelectedUrl && currentSelectedUrl === img.url;
    const card = document.createElement('div');
    card.className = 'storage-file-card';
    if (isSelected) {
      card.style.borderColor = '#16a34a';
      card.style.boxShadow = '0 0 0 2px rgba(22, 163, 74, 0.18)';
    }

    const thumbWrap = document.createElement('div');
    thumbWrap.style.cssText =
      'aspect-ratio: 1/1; overflow: hidden; border-radius: var(--radius-sm); background: #fff; cursor: pointer; position: relative;';
    thumbWrap.title = selectMode ? 'Haz clic para elegir esta imagen' : img.filename;

    const imgEl = document.createElement('img');
    imgEl.src = img.url;
    imgEl.alt = img.filename;
    imgEl.loading = 'lazy';
    imgEl.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
    thumbWrap.appendChild(imgEl);

    if (isSelected) {
      const badge = document.createElement('span');
      badge.textContent = '✓ Seleccionada';
      badge.style.cssText =
        'position: absolute; top: 6px; right: 6px; background: #16a34a; color: #fff; font-size: 0.68rem; font-weight: 700; padding: 2px 6px; border-radius: 999px;';
      thumbWrap.appendChild(badge);
    }

    thumbWrap.addEventListener('click', () => {
      if (selectMode) {
        selectGalleryImage(img.url);
      } else {
        copyToClipboard(img.url);
      }
    });

    const nameEl = document.createElement('div');
    nameEl.style.cssText =
      'font-size: 0.75rem; color: var(--text-main); font-weight: 600; word-break: break-word; line-height: 1.25;';
    nameEl.textContent = img.filename;

    const footerEl = document.createElement('div');
    footerEl.style.cssText =
      'display: flex; justify-content: space-between; align-items: center; margin-top: auto; gap: 0.35rem;';

    const sizeEl = document.createElement('span');
    sizeEl.style.cssText = 'font-size: 0.7rem; color: var(--text-subtle);';
    sizeEl.textContent = `${img.sizeKb} KB`;

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'btn btn-primary btn-sm';
    actionBtn.textContent = selectMode ? 'Seleccionar' : 'Copiar URL';
    actionBtn.addEventListener('click', () => {
      if (selectMode) {
        selectGalleryImage(img.url);
      } else {
        copyToClipboard(img.url);
      }
    });

    footerEl.appendChild(sizeEl);
    footerEl.appendChild(actionBtn);

    card.appendChild(thumbWrap);
    card.appendChild(nameEl);
    card.appendChild(footerEl);
    container.appendChild(card);
  });
}

function selectGalleryImage(url) {
  if (adminState.galleryTarget === 'client-logo') {
    document.getElementById('client-logo-url').value = url;
    const preview = document.getElementById('client-logo-preview');
    preview.src = url;
    preview.style.display = 'block';
    document.getElementById('client-logo-placeholder').style.display = 'none';
  } else if (adminState.galleryTarget === 'client-cover') {
    document.getElementById('client-cover-url').value = url;
    const preview = document.getElementById('client-cover-preview');
    preview.src = url;
    preview.style.display = 'block';
    document.getElementById('client-cover-placeholder').style.display = 'none';
  } else {
    const urlInput = document.getElementById('prod-image-url');
    const preview = document.getElementById('image-preview');
    const placeholder = document.getElementById('image-preview-placeholder');

    urlInput.value = url;
    preview.src = url;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
  }

  galleryModal.classList.remove('active');
  showToast('Imagen seleccionada desde Storage.');
}

// Utilidad: Copiar al Portapapeles
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Enlace copiado al portapapeles: ${text}`);
  }).catch(() => {
    prompt('Copia este enlace único:', text);
  });
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
