# 🎨 Catálogo Digital Autogestionable

Sistema profesional de catálogo digital autogestionable diseñado con una arquitectura web robusta, ligera y desacoplada. Incluye una interfaz pública interactiva y responsiva con pedidos directos a WhatsApp y un panel de administración privado y seguro para la gestión integral de productos, inventario e imágenes.

---

## 🏛️ Arquitectura del Sistema

El proyecto sigue una arquitectura en capas basada en principios de separación de responsabilidades (SoC) y Clean Architecture:

```
CATALOGO/
├── src/
│   ├── config/
│   │   └── config.js              # Variables de configuración, rutas y constantes
│   ├── db/
│   │   ├── database.js            # Motor SQLite nativo (node:sqlite) con soporte WAL
│   │   └── seed.js                # Sembrado automático de administrador e imágenes iniciales
│   ├── middleware/
│   │   ├── auth.js                # Validación de sesiones y tokens criptográficos
│   │   └── upload.js              # Manejo y sanitización de carga de imágenes (Multer)
│   ├── routes/
│   │   ├── authRoutes.js          # Endpoints de autenticación (login, logout, me)
│   │   ├── productRoutes.js       # CRUD de productos y gestión de imágenes
│   │   └── statsRoutes.js         # KPIs y métricas del inventario para el dashboard
│   ├── services/
│   │   ├── authService.js         # Hashing con PBKDF2 SHA-512 y tokens criptográficos
│   │   └── productService.js      # Lógica de negocio, consultas SQL y filtros
│   └── server.js                  # Servidor Express, middlewares y entrega de estáticos
├── public/
│   ├── css/
│   │   └── styles.css             # Sistema de diseño moderno, variables CSS y responsive
│   ├── js/
│   │   ├── app.js                 # Lógica del catálogo público (filtros, carrito WhatsApp)
│   │   └── admin.js               # Lógica del panel administrativo (CRUD, KPIs, modales)
│   ├── index.html                 # Vista pública del catálogo
│   ├── admin.html                 # Vista del panel de administración
│   └── login.html                 # Vista de autenticación segura
├── productos/                     # Directorio de imágenes físicas de productos
├── data/
│   └── catalogo.sqlite            # Base de datos persistente SQLite
├── package.json
└── README.md
```

---

## 📦 Esquema de Datos del Producto

La tabla `productos` cumple estrictamente con el esquema especificado:

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| **`id`** | INTEGER | PRIMARY KEY AUTOINCREMENT | Identificador único numérico |
| **`nombre`** | TEXT | NOT NULL | Título o nombre comercial del producto |
| **`descripcion`** | TEXT | NOT NULL | Descripción detallada, especificaciones técnicas y uso |
| **`precio`** | REAL | NOT NULL, CHECK(precio >= 0) | Precio unitario con precisión decimal |
| **`inventario`** | INTEGER | NOT NULL DEFAULT 0, CHECK(inventario >= 0) | Unidades físicas disponibles en stock |
| **`categoria`** | TEXT | NOT NULL | Categoría taxonómica (ej. Herramientas, Washi Tapes) |
| **`imagen_url`** | TEXT | NOT NULL | Ruta web estática (`/productos/...`) o URL remota |
| **`created_at`** | TEXT | DEFAULT CURRENT_TIMESTAMP | Fecha de creación del registro |
| **`updated_at`** | TEXT | DEFAULT CURRENT_TIMESTAMP | Fecha de última modificación |

---

## 🚀 Puesta en Marcha

### 1. Iniciar el Servidor
En la raíz del proyecto, ejecuta:
```bash
npm start
```
O directamente con Node.js:
```bash
node src/server.js
```

### 2. Acceso a las Interfaces
- **Catálogo Público:** [http://localhost:3000](http://localhost:3000)
- **Panel Administrativo:** [http://localhost:3000/admin](http://localhost:3000/admin)
- **Inicio de Sesión:** [http://localhost:3000/login](http://localhost:3000/login)

---

## 🔐 Credenciales del Administrador

Por defecto, el sistema inicializa una cuenta de administrador segura:
- **Usuario:** `admin`
- **Contraseña:** `admin123456`

*(Las contraseñas se almacenan con salt criptográfico de 16 bytes y PBKDF2 SHA-512 a 100,000 iteraciones).*

---

## ✨ Características Principales

### 🛒 1. Catálogo Público (Totalmente Responsivo)
- **Diseño Mobile-First:** Se adapta con fluidez a smartphones, tablets y monitores de alta resolución.
- **Pestañas de Categoría Dinámicas:** Conteo automático de productos disponibles por categoría.
- **Búsqueda en Tiempo Real:** Filtrado con debounce por nombre o descripción.
- **Insignias de Inventario:**
  - 🟢 *En Stock:* Más de 5 unidades disponibles.
  - 🟡 *Stock Bajo:* 5 o menos unidades ("¡Últimas X unidades!").
  - 🔴 *Agotado:* Sin existencias (el botón de pedido se deshabilita automáticamente).
- **Modal de Vista Rápida:** Visualización de alta resolución y detalles completos del producto.
- **Carrito de Pedidos WhatsApp:** Permite a los clientes seleccionar múltiples ítems, definir cantidades y generar con un solo clic un mensaje formateado y totalizado directo al número de atención por WhatsApp.

### 🛡️ 2. Panel de Control Administrativo (Privado y Seguro)
- **Acceso Protegido:** Requiere sesión activa con token criptográfico; las rutas de la API administrativa rechazan accesos no autorizados con código HTTP 401.
- **Indicadores Clave (KPIs):**
  - Total de productos registrados.
  - Valorización monetaria total del inventario ($).
  - Contador de productos con stock bajo (≤ 5 unidades).
  - Contador de productos agotados.
- **Gestión Integral de Productos (CRUD):**
  - **Crear Producto:** Soporte para subir archivos desde la computadora o seleccionar imágenes existentes en la carpeta `productos/`.
  - **Editar Producto:** Modificación inmediata de campos con previsualización en vivo.
  - **Eliminar Producto:** Modal de confirmación para prevenir eliminaciones accidentales.
  - **Ajuste Rápido de Stock:** Botones `+` y `-` directamente en la tabla con actualización AJAX instantánea sin recargar la página.
- **Galería de Imágenes Locales:** Visualizador de todos los archivos JPG/PNG almacenados en `productos/`.

### 🖼️ 3. Procesamiento de Imágenes Locales
- Las 16 imágenes iniciales ubicadas en el directorio `productos/` fueron procesadas e indexadas automáticamente con nombres, descripciones y precios acordes a los productos reales.
- El servidor expone la ruta estática segura `/productos/...` con codificación de caracteres URL para garantizar compatibilidad con navegadores modernos.
