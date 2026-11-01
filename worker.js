/**
 * Worker de Librería Ichinén (modelo Workers + Static Assets).
 *
 * - Sirve la carpeta public/ como sitio estático (binding ASSETS).
 * - POST /admin/api  → reemplazo de subir.php: valida la contraseña,
 *   guarda el Excel en KV (binding DATOS) y dispara el build en GitHub.
 * - GET /datos/listado.xlsx → devuelve el último Excel guardado en KV,
 *   para que GitHub Actions lo baje (esta es la URL de EXCEL_URL).
 *
 * Variables/secretos (se configuran en el panel de Cloudflare):
 *   PANEL_CLAVE     (secret)  contraseña del panel
 *   GITHUB_TOKEN    (secret)  PAT fine-grained con Actions: read/write del repo
 *   GITHUB_OWNER/REPO/WORKFLOW/REF  (vars, ya vienen en wrangler.toml)
 *   DATOS  (KV binding)  espacio donde se guarda listado.xlsx
 *   ASSETS (binding de assets, lo maneja Cloudflare solo)
 */

const MAX_MB = 24; // margen bajo el límite de 25 MiB por valor de KV

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function dispararGitHub(env) {
  if (!env.GITHUB_TOKEN) return null; // sin token: se actualiza en la corrida semanal
  const owner = env.GITHUB_OWNER || "serfalco";
  const repo = env.GITHUB_REPO || "catalogo-ichinen";
  const wf = env.GITHUB_WORKFLOW || "catalogo.yml";
  const ref = env.GITHUB_REF || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "Ichinen-Panel",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref }),
  });
  return r.status === 204;
}

async function subirCatalogo(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, mensaje: "Pedido inválido." }, 400);
  }

  const clave = form.get("clave");
  if (!env.PANEL_CLAVE || clave !== env.PANEL_CLAVE) {
    return json({ ok: false, mensaje: "Contraseña incorrecta." }, 401);
  }

  const archivo = form.get("archivo");
  if (!archivo || typeof archivo === "string") {
    return json({ ok: false, mensaje: "No llegó ningún archivo." }, 400);
  }

  const nombre = (archivo.name || "").toLowerCase();
  if (!nombre.endsWith(".xlsx")) {
    return json({ ok: false, mensaje: "El archivo tiene que ser un Excel (.xlsx)." }, 400);
  }
  if (archivo.size > MAX_MB * 1024 * 1024) {
    return json({ ok: false, mensaje: `El archivo es muy grande (máximo ${MAX_MB} MB).` }, 400);
  }

  if (!env.DATOS) {
    return json({ ok: false, mensaje: "El almacenamiento no está configurado (falta binding DATOS)." }, 500);
  }

  try {
    const buf = await archivo.arrayBuffer();
    await env.DATOS.put("listado.xlsx", buf);
  } catch {
    return json({ ok: false, mensaje: "No se pudo guardar el archivo. Probá de nuevo." }, 500);
  }

  const limpiado = form.get("limpiado") === "1";
  const extra = limpiado ? " (con limpieza aplicada)" : "";
  const disparo = await dispararGitHub(env);

  let mensaje;
  if (disparo === true) {
    mensaje = `¡Listo! Catálogo subido${extra}. La web se está actualizando ahora (tarda unos minutos).`;
  } else if (disparo === false) {
    mensaje = `Catálogo subido correctamente${extra}. La web se actualizará en la próxima revisión (el disparo automático no respondió).`;
  } else {
    mensaje = `¡Listo! Catálogo subido correctamente${extra}. La web se actualizará dentro de los próximos días.`;
  }
  return json({ ok: true, mensaje });
}

async function servirExcel(env) {
  if (!env.DATOS) return new Response("Almacenamiento no configurado.", { status: 500 });
  const stream = await env.DATOS.get("listado.xlsx", { type: "stream" });
  if (!stream) return new Response("Todavía no se subió ningún catálogo.", { status: 404 });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Cache-Control": "no-store",
    },
  });
}

// --- Contador de consultas por WhatsApp ---------------------------------------
// Cuenta clics en los botones de WhatsApp del sitio y del catálogo. Sin cookies
// ni datos personales: solo qué página y qué libro, agregados por mes en KV.
const ORIGENES_OK = ["https://catalogo.ichinen.com.ar", "https://ichinen.com.ar",
                     "https://www.ichinen.com.ar"];

function cors(request) {
  const o = request.headers.get("Origin") || "";
  return ORIGENES_OK.includes(o) ? { "Access-Control-Allow-Origin": o } : {};
}

function fechaAR() {
  // Día en hora de Buenos Aires (UTC-3, sin horario de verano)
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function limpiar(t, max) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9\-\/\.]/g, "").slice(0, max);
}

async function registrarClic(request, env) {
  const h = cors(request);
  if (!env.DATOS) return new Response(null, { status: 204, headers: h });
  let d = {};
  try { d = JSON.parse(await request.text()); } catch { /* cuerpo vacío o roto */ }
  const libro = limpiar(d.l, 90);
  const pagina = limpiar(d.p, 40) || "otra";
  const dia = fechaAR();
  const clave = "consultas:" + dia.slice(0, 7);
  const actual = (await env.DATOS.get(clave, { type: "json" })) ||
                 { total: 0, dias: {}, paginas: {}, libros: {} };
  actual.total += 1;
  actual.dias[dia] = (actual.dias[dia] || 0) + 1;
  actual.paginas[pagina] = (actual.paginas[pagina] || 0) + 1;
  if (libro) actual.libros[libro] = (actual.libros[libro] || 0) + 1;
  await env.DATOS.put(clave, JSON.stringify(actual));
  return new Response(null, { status: 204, headers: h });
}

async function verConsultas(url, env) {
  if (!env.DATOS) return json({ ok: false }, 500);
  const mes = /^\d{4}-\d{2}$/.test(url.searchParams.get("mes") || "")
    ? url.searchParams.get("mes") : fechaAR().slice(0, 7);
  const datos = (await env.DATOS.get("consultas:" + mes, { type: "json" })) ||
                { total: 0, dias: {}, paginas: {}, libros: {} };
  return new Response(JSON.stringify({ mes, ...datos }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/admin/api") {
      if (request.method !== "POST") {
        return json({ ok: false, mensaje: "Método no permitido." }, 405);
      }
      return subirCatalogo(request, env);
    }

    if (url.pathname === "/api/clic") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return registrarClic(request, env);
    }

    if (url.pathname === "/api/consultas") {
      return verConsultas(url, env);
    }

    if (url.pathname === "/datos/listado.xlsx") {
      return servirExcel(env);
    }

    // Todo lo demás: archivos estáticos de la carpeta public/
    return env.ASSETS.fetch(request);
  },
};
