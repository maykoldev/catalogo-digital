const zlib = require('zlib');
const path = require('path');

/**
 * Decodifica entidades XML básicas y numéricas
 */
function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Escapa texto para insertar en nodos XML
 */
function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extrae archivos de un contenedor ZIP (.xlsx) en memoria usando zlib nativo de Node.js
 */
function extractZipEntries(buffer) {
  const entries = new Map();

  // Buscar End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minEocdOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    let ptr = cdOffset;

    for (let i = 0; i < totalEntries && ptr + 46 <= buffer.length; i++) {
      if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
      const compressionMethod = buffer.readUInt16LE(ptr + 10);
      const compressedSize = buffer.readUInt32LE(ptr + 20);
      const fileNameLen = buffer.readUInt16LE(ptr + 28);
      const extraLen = buffer.readUInt16LE(ptr + 30);
      const commentLen = buffer.readUInt16LE(ptr + 32);
      const localHeaderOffset = buffer.readUInt32LE(ptr + 42);

      const fileName = buffer.slice(ptr + 46, ptr + 46 + fileNameLen).toString('utf8');
      ptr += 46 + fileNameLen + extraLen + commentLen;

      if (localHeaderOffset + 30 > buffer.length) continue;
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

      const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compData = buffer.slice(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        entries.set(fileName, compData);
      } else if (compressionMethod === 8) {
        try {
          entries.set(fileName, zlib.inflateRawSync(compData));
        } catch (_) {}
      }
    }
    return entries;
  }

  // Respaldo: recorrer cabeceras locales si no se halló EOCD
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;

    if ((flags & 0x08) !== 0) break; // Data descriptor requiere Central Directory
    const compData = buffer.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      entries.set(name, compData);
    } else if (method === 8) {
      try {
        entries.set(name, zlib.inflateRawSync(compData));
      } catch (_) {}
    }
    offset = dataStart + compSize;
  }

  return entries;
}

/**
 * Convierte referencia de columna Excel (ej. "A" -> 0, "B" -> 1, "AA" -> 26)
 */
function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/**
 * Convierte índice numérico 0-based a letra de columna Excel (0 -> "A")
 */
function indexToColLetters(index) {
  let n = index + 1;
  let str = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str;
}

/**
 * Parsea un archivo Excel (.xlsx) desde un Buffer y devuelve una matriz de filas/columnas
 */
function parseXlsxBuffer(buffer) {
  const entries = extractZipEntries(buffer);
  if (entries.size === 0) {
    throw new Error('El archivo Excel (.xlsx) no es válido o está corrupto.');
  }

  // 1. Leer tabla de textos compartidos (xl/sharedStrings.xml) si existe
  const sharedStrings = [];
  const sstBuf = entries.get('xl/sharedStrings.xml');
  if (sstBuf) {
    const sstXml = sstBuf.toString('utf8');
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const inner = siMatch[1];
      const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
      let tMatch;
      let combined = '';
      while ((tMatch = tRegex.exec(inner)) !== null) {
        combined += decodeXmlEntities(tMatch[1]);
      }
      sharedStrings.push(combined);
    }
  }

  // 2. Buscar la primera hoja de cálculo disponible
  let sheetXml = null;
  if (entries.has('xl/worksheets/sheet1.xml')) {
    sheetXml = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  } else {
    for (const [entryName, data] of entries.entries()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName)) {
        sheetXml = data.toString('utf8');
        break;
      }
    }
  }

  if (!sheetXml) {
    throw new Error('No se encontró ninguna hoja de cálculo dentro del archivo .xlsx.');
  }

  // 3. Extraer filas (<row>) y celdas (<c>)
  const rows = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const rowCells = [];
    const cellRegex = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    let fallbackColIdx = 0;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1] || '';
      const cellInner = cellMatch[2] || '';

      const refMatch = /\br="([A-Z]+)\d+"/i.exec(attrs);
      const colIdx = refMatch ? colLettersToIndex(refMatch[1].toUpperCase()) : fallbackColIdx;
      fallbackColIdx = colIdx + 1;

      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch ? typeMatch[1] : '';

      let value = '';
      if (cellType === 'inlineStr') {
        const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
        let tMatch;
        while ((tMatch = tRegex.exec(cellInner)) !== null) {
          value += decodeXmlEntities(tMatch[1]);
        }
      } else {
        const vMatch = /<v(?:\s+[^>]*)?>([\s\S]*?)<\/v>/.exec(cellInner);
        if (vMatch) {
          const rawVal = decodeXmlEntities(vMatch[1]);
          if (cellType === 's') {
            const sstIdx = parseInt(rawVal, 10);
            value = !isNaN(sstIdx) && sharedStrings[sstIdx] !== undefined ? sharedStrings[sstIdx] : rawVal;
          } else {
            value = rawVal;
          }
        }
      }

      while (rowCells.length < colIdx) {
        rowCells.push('');
      }
      rowCells[colIdx] = String(value ?? '').trim();
    }

    if (rowCells.some((cell) => cell !== '')) {
      rows.push(rowCells);
    }
  }

  return rows;
}

/**
 * Parsea contenido CSV o TSV (detectando automáticamente delimitador `,`, `;` o `\t`)
 */
function parseCsvText(rawText) {
  const cleanText = String(rawText || '').replace(/^\uFEFF/, '');
  if (!cleanText.trim()) return [];

  // Detectar delimitador en la primera línea no vacía
  const firstLine = cleanText.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;

  let delimiter = ',';
  if (tabCount > commaCount && tabCount > semiCount) {
    delimiter = '\t';
  } else if (semiCount > commaCount) {
    delimiter = ';';
  }

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const nextCh = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"' && nextCh === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\r' && nextCh === '\n') {
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c !== '')) rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c !== '')) rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }

  currentRow.push(currentField.trim());
  if (currentRow.some((c) => c !== '')) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Normaliza un nombre de columna para mapeo flexible
 */
function normalizeHeaderKey(header) {
  return String(header || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Limpia y convierte un valor monetario o numérico (ej. "$ 12,50" o "S/ 45.00")
 */
function parseNumericField(rawVal, defaultVal = null) {
  if (rawVal === undefined || rawVal === null) return defaultVal;
  let str = String(rawVal).trim();
  if (!str) return defaultVal;

  // Remover símbolos de moneda y espacios
  str = str.replace(/[^0-9.,-]/g, '');
  if (!str) return defaultVal;

  // Si tiene coma como separador decimal (ej. "15,50") y no tiene punto
  if (str.includes(',') && !str.includes('.')) {
    str = str.replace(',', '.');
  } else if (str.includes(',') && str.includes('.')) {
    // Si tiene ambos (ej. "1,250.50" o "1.250,50")
    const lastComma = str.lastIndexOf(',');
    const lastDot = str.lastIndexOf('.');
    if (lastComma > lastDot) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  }

  const num = Number(str);
  return isNaN(num) ? defaultVal : num;
}

/**
 * Convierte la matriz de filas de un Excel o CSV en objetos de producto listos para validar/importar
 */
function mapMatrixToProducts(matrix, { storageFiles = [] } = {}) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return [];
  }

  const headerRow = matrix[0];
  const columnMap = {
    nombre: -1,
    categoria: -1,
    precio: -1,
    precio_mayor: -1,
    inventario: -1,
    descripcion: -1,
    imagen_url: -1
  };

  headerRow.forEach((colName, idx) => {
    const key = normalizeHeaderKey(colName);
    if (!key) return;

    if (
      columnMap.nombre === -1 &&
      ['nombre', 'producto', 'nombreproducto', 'nombredelproducto', 'articulo', 'item', 'titulo', 'name', 'title'].includes(key)
    ) {
      columnMap.nombre = idx;
    } else if (
      columnMap.precio_mayor === -1 &&
      [
        'preciomayor',
        'precioalpormayor',
        'preciopormayor',
        'preciomayorista',
        'mayor',
        'mayorista',
        'wholesale',
        'wholesaleprice'
      ].includes(key)
    ) {
      columnMap.precio_mayor = idx;
    } else if (
      columnMap.precio === -1 &&
      ['precio', 'preciounitario', 'preciodetal', 'preciounitariodetal', 'detal', 'valor', 'costo', 'price', 'pvp'].includes(key)
    ) {
      columnMap.precio = idx;
    } else if (
      columnMap.categoria === -1 &&
      ['categoria', 'categorias', 'rubro', 'departamento', 'linea', 'familia', 'category'].includes(key)
    ) {
      columnMap.categoria = idx;
    } else if (
      columnMap.inventario === -1 &&
      ['inventario', 'stock', 'cantidad', 'unidades', 'existencia', 'existencias', 'disponible', 'qty'].includes(key)
    ) {
      columnMap.inventario = idx;
    } else if (
      columnMap.descripcion === -1 &&
      ['descripcion', 'descripciondetallada', 'detalle', 'detalles', 'observaciones', 'description'].includes(key)
    ) {
      columnMap.descripcion = idx;
    } else if (
      columnMap.imagen_url === -1 &&
      ['imagen', 'imagenurl', 'urlimagen', 'foto', 'fotourl', 'archivoimagen', 'nombreimagen', 'image', 'imageurl'].includes(key)
    ) {
      columnMap.imagen_url = idx;
    }
  });

  // Si la primera fila no tenía encabezados reconocibles, asumir orden estándar de la plantilla:
  // [nombre, categoria, precio, precio_mayor, inventario, descripcion, imagen_url]
  let startRowIndex = 1;
  if (columnMap.nombre === -1 && columnMap.precio === -1) {
    columnMap.nombre = 0;
    columnMap.categoria = 1;
    columnMap.precio = 2;
    columnMap.precio_mayor = 3;
    columnMap.inventario = 4;
    columnMap.descripcion = 5;
    columnMap.imagen_url = 6;

    // Verificar si la fila 0 parece ser un dato real (el campo precio es numérico)
    const possiblePrice = parseNumericField(headerRow[2], null);
    if (possiblePrice !== null) {
      startRowIndex = 0;
    }
  }

  // Mapa rápido para resolver nombres de archivo de imagen dentro de la carpeta de Storage de la tienda
  const storageLookup = new Map();
  for (const f of storageFiles || []) {
    if (f && f.name && f.url) {
      storageLookup.set(f.name.toLowerCase().trim(), f.url);
      const baseNoExt = path.basename(f.name, path.extname(f.name)).toLowerCase().trim();
      if (!storageLookup.has(baseNoExt)) {
        storageLookup.set(baseNoExt, f.url);
      }
    }
  }

  const parsedProducts = [];
  for (let r = startRowIndex; r < matrix.length; r++) {
    const row = matrix[r];
    if (!Array.isArray(row) || row.every((c) => !String(c || '').trim())) continue;

    const rawNombre = columnMap.nombre !== -1 ? String(row[columnMap.nombre] || '').trim() : '';
    const rawCat = columnMap.categoria !== -1 ? String(row[columnMap.categoria] || '').trim() : '';
    const rawPrecio = columnMap.precio !== -1 ? row[columnMap.precio] : '';
    const rawMayor = columnMap.precio_mayor !== -1 ? row[columnMap.precio_mayor] : '';
    const rawStock = columnMap.inventario !== -1 ? row[columnMap.inventario] : '';
    const rawDesc = columnMap.descripcion !== -1 ? String(row[columnMap.descripcion] || '').trim() : '';
    const rawImg = columnMap.imagen_url !== -1 ? String(row[columnMap.imagen_url] || '').trim() : '';

    if (!rawNombre && (rawPrecio === '' || rawPrecio === undefined)) {
      continue;
    }

    const precio = parseNumericField(rawPrecio, 0);
    const parsedMayor = parseNumericField(rawMayor, null);
    const precio_mayor = parsedMayor !== null && parsedMayor > 0 ? Number(parsedMayor.toFixed(2)) : null;
    const parsedStock = parseNumericField(rawStock, 10);
    const inventario = parsedStock !== null && parsedStock >= 0 ? Math.floor(parsedStock) : 10;

    // Resolver URL de imagen (si puso URL completa o solo el nombre del archivo en Storage)
    let imagen_url = rawImg;
    if (imagen_url && !/^https?:\/\//i.test(imagen_url) && !imagen_url.startsWith('/')) {
      const cleanFileKey = path.basename(imagen_url).toLowerCase().trim();
      const cleanNoExt = path.basename(cleanFileKey, path.extname(cleanFileKey)).toLowerCase().trim();
      if (storageLookup.has(cleanFileKey)) {
        imagen_url = storageLookup.get(cleanFileKey);
      } else if (storageLookup.has(cleanNoExt)) {
        imagen_url = storageLookup.get(cleanNoExt);
      }
    }

    parsedProducts.push({
      rowNumber: r + 1,
      nombre: rawNombre,
      categoria: rawCat || 'General',
      precio: precio !== null && precio >= 0 ? Number(precio.toFixed(2)) : 0,
      precio_mayor,
      inventario,
      descripcion: rawDesc,
      imagen_url: imagen_url || ''
    });
  }

  return parsedProducts;
}

/**
 * Calcula CRC32 en Node.js puro para crear contenedores ZIP (.xlsx)
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Empaqueta una lista de archivos [{ name, data: Buffer }] en un archivo ZIP válido (.xlsx)
 */
function buildZipBuffer(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression method: 0 (store)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, dataBuf);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: 0
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + dataBuf.length;
  }

  const centralDirSize = centralHeaders.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * Genera una plantilla Excel (.xlsx) real lista para usar en Microsoft Excel / Google Sheets
 */
function generateXlsxTemplateBuffer(sampleRows = null) {
  const rows = sampleRows || [
    ['nombre', 'categoria', 'precio', 'precio_mayor', 'inventario', 'descripcion', 'imagen_url'],
    [
      'Pistola de Silicona Caliente 20W',
      'Herramientas',
      15.5,
      12.0,
      25,
      'Pistola térmica ergonómica para barras de 7mm',
      ''
    ],
    [
      'Set de Acrílicos Profesionales x12',
      'Pinturas',
      22.0,
      18.5,
      40,
      'Colores intensos de secado rápido',
      ''
    ]
  ];

  const rowsXml = rows
    .map((cols, rIdx) => {
      const rowNum = rIdx + 1;
      const cellsXml = cols
        .map((val, cIdx) => {
          const ref = `${indexToColLetters(cIdx)}${rowNum}`;
          if (typeof val === 'number' && !isNaN(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Productos" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`;

  return buildZipBuffer([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: relsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml }
  ]);
}

/**
 * Genera una plantilla CSV con BOM UTF-8 compatible con Excel en español
 */
function generateCsvTemplateString(sampleRows = null) {
  const rows = sampleRows || [
    ['nombre', 'categoria', 'precio', 'precio_mayor', 'inventario', 'descripcion', 'imagen_url'],
    [
      'Pistola de Silicona Caliente 20W',
      'Herramientas',
      '15.50',
      '12.00',
      '25',
      'Pistola térmica ergonómica para barras de 7mm',
      ''
    ],
    [
      'Set de Acrílicos Profesionales x12',
      'Pinturas',
      '22.00',
      '18.50',
      '40',
      'Colores intensos de secado rápido',
      ''
    ]
  ];

  const lines = rows.map((cols) =>
    cols
      .map((val) => {
        const s = String(val ?? '');
        if (s.includes(',') || s.includes(';') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      })
      .join(',')
  );

  return '\uFEFF' + lines.join('\r\n');
}

module.exports = {
  parseXlsxBuffer,
  parseCsvText,
  mapMatrixToProducts,
  generateXlsxTemplateBuffer,
  generateCsvTemplateString
};
