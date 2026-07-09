/* prelimpieza.js — motor de prelimpieza del catálogo Ichinén
 *
 * Funciona igual en el navegador de Diego y en Node (para tests).
 * En el navegador, SheetJS (XLSX) se carga por <script> antes que este archivo.
 * En Node, se requiere arriba (ver bloque final de test).
 *
 * Flujo:
 *   1. leerExcel(file)        -> {filas, headers, nombreHoja}
 *   2. analizar(filas)        -> diagnóstico para pintar la pantalla
 *   3. aplicar(filas, opciones, diag) -> filas limpias
 *   4. exportarExcel(...)     -> Blob .xlsx para subir
 *
 * Criterio rector: prudente. Ante la duda, no toca. Nunca bloquea.
 */

(function (global) {
  'use strict';

  function normalizar(s) {
    if (s === null || s === undefined) return '';
    return String(s).trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9ñ ]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  const AUTORES_GENERICOS = new Set(['aa vv', 'varios autores', 'anonimo', '']);
  const HOJA_LIBROS = 'Libros';
  const UMBRAL_GTIN = 5; // mismo GTIN en N+ títulos distintos = sospechoso

  // ---------- 1. LECTURA ----------
  function leerExcel(arrayBuffer, XLSX) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const nombreHoja = wb.SheetNames.includes(HOJA_LIBROS)
      ? HOJA_LIBROS : wb.SheetNames[0];
    const ws = wb.Sheets[nombreHoja];
    const filas = XLSX.utils.sheet_to_json(ws, { defval: null });
    const headers = filas.length ? Object.keys(filas[0]) : [];
    return { wb, filas, headers, nombreHoja };
  }

  // ---------- 2. ANÁLISIS ----------
  function analizar(filas) {
    const total = filas.length;

    // 2.1 Tapas equivocadas (GTIN repetido en muchos títulos distintos)
    const porGtin = new Map();
    filas.forEach((f, i) => {
      const raw = f.GTIN;
      const g = (raw === null || raw === undefined || String(raw).trim() === '')
        ? null : String(raw).trim();
      if (!g) return;
      if (!porGtin.has(g)) porGtin.set(g, []);
      porGtin.get(g).push(i);
    });
    const gtinBasura = new Set();
    const filasTapas = [];
    for (const [g, idxs] of porGtin) {
      if (idxs.length >= UMBRAL_GTIN) {
        const titulosDistintos = new Set(idxs.map(i => normalizar(filas[i].BOOK_TITLE))).size;
        if (titulosDistintos >= UMBRAL_GTIN) {
          gtinBasura.add(g);
          idxs.forEach(i => filasTapas.push(i));
        }
      }
    }

    // 2.2 Fichas 100% idénticas
    const vistas = new Set();
    const idxIdenticas = [];
    filas.forEach((f, i) => {
      const firma = JSON.stringify(f);
      if (vistas.has(firma)) idxIdenticas.push(i);
      else vistas.add(firma);
    });

    // 2.3 Posibles repetidos (título+autor+editorial+año, sin genéricos)
    const porClave = new Map();
    filas.forEach((f, i) => {
      const t = normalizar(f.BOOK_TITLE);
      const a = normalizar(f.AUTHOR);
      if (t === '' || AUTORES_GENERICOS.has(a)) return;
      const clave = [t, a, normalizar(f.BOOK_PUBLISHER), String(f.PUBLICATION_YEAR ?? '')].join('|');
      if (!porClave.has(clave)) porClave.set(clave, []);
      porClave.get(clave).push(i);
    });
    const gruposPosibles = [];
    let sobrantesPosibles = 0;
    for (const [clave, idxs] of porClave) {
      if (idxs.length > 1) {
        sobrantesPosibles += idxs.length - 1;
        gruposPosibles.push({
          titulo: filas[idxs[0]].BOOK_TITLE,
          autor: filas[idxs[0]].AUTHOR,
          indices: idxs,
        });
      }
    }
    gruposPosibles.sort((a, b) => b.indices.length - a.indices.length);

    return {
      total,
      tapas:     { gtinBasura: [...gtinBasura], indices: filasTapas },
      identicas: { indices: idxIdenticas },
      posibles:  { grupos: gruposPosibles, sobrantes: sobrantesPosibles },
    };
  }

  // ---------- 3. APLICAR LIMPIEZA ----------
  // opciones: { tapas:bool, identicas:bool, quitarPosibles:[indices...] }
  function aplicar(filas, opciones, diag) {
    let salida = filas.map(f => ({ ...f })); // copia, no mutar original
    const aBorrar = new Set();

    if (opciones.identicas) {
      diag.identicas.indices.forEach(i => aBorrar.add(i));
    }
    if (Array.isArray(opciones.quitarPosibles)) {
      opciones.quitarPosibles.forEach(i => aBorrar.add(i));
    }
    // tapas: NO borra, blanquea el GTIN para que no baje portada equivocada
    if (opciones.tapas) {
      const basura = new Set(diag.tapas.gtinBasura);
      salida.forEach(f => {
        if (f.GTIN != null && basura.has(String(f.GTIN).trim())) f.GTIN = null;
      });
    }

    salida = salida.filter((_, i) => !aBorrar.has(i));
    return { filas: salida, borradas: aBorrar.size };
  }

  // ---------- 4. EXPORTAR ----------
  function exportarExcel(wbOriginal, nombreHoja, filasLimpias, XLSX) {
    const wb = XLSX.utils.book_new();
    // preservo el orden de columnas original
    const headers = filasLimpias.length ? Object.keys(filasLimpias[0]) : [];
    const ws = XLSX.utils.json_to_sheet(filasLimpias, { header: headers });
    XLSX.utils.book_append_sheet(wb, ws, nombreHoja);
    // copio las otras hojas tal cual venían (hidden, revistas, etc.)
    wbOriginal.SheetNames.forEach(n => {
      if (n !== nombreHoja) XLSX.utils.book_append_sheet(wb, wbOriginal.Sheets[n], n);
    });
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  }

  global.Prelimpieza = { normalizar, leerExcel, analizar, aplicar, exportarExcel, UMBRAL_GTIN };

})(typeof window !== 'undefined' ? window : global);


// ---------- TEST (solo Node) ----------
if (typeof require !== 'undefined' && require.main === module) {
  const XLSX = require('xlsx');
  const fs = require('fs');
  const buf = fs.readFileSync(process.argv[2]);
  const { wb, filas, nombreHoja } = global.Prelimpieza.leerExcel(buf, XLSX);
  const diag = global.Prelimpieza.analizar(filas);

  console.log('=== ANÁLISIS ===');
  console.log('Total:', diag.total);
  console.log('Tapas: GTIN basura', diag.tapas.gtinBasura.length, '| filas', diag.tapas.indices.length);
  console.log('Idénticas:', diag.identicas.indices.length);
  console.log('Posibles: grupos', diag.posibles.grupos.length, '| sobrantes', diag.posibles.sobrantes);

  // simulo: tildo tapas + idénticas, no toco posibles
  const res = global.Prelimpieza.aplicar(filas, { tapas: true, identicas: true, quitarPosibles: [] }, diag);
  console.log('\n=== APLICAR (tapas + idénticas) ===');
  console.log('Filas antes:', filas.length, '-> después:', res.filas.length, '| borradas:', res.borradas);
  const gtinVacios = res.filas.filter(f => f.GTIN == null).length;
  console.log('GTIN blanqueados (quedaron null):', gtinVacios);

  // verifico reexport
  const out = global.Prelimpieza.exportarExcel(wb, nombreHoja, res.filas, XLSX);
  fs.writeFileSync('/home/claude/work/limpio_test.xlsx', Buffer.from(out));
  const rb = global.Prelimpieza.leerExcel(fs.readFileSync('/home/claude/work/limpio_test.xlsx'), XLSX);
  console.log('\n=== REEXPORT verificado ===');
  console.log('Hojas:', rb.wb.SheetNames.join(', '));
  console.log('Filas en hoja Libros del archivo limpio:', rb.filas.length);
}
