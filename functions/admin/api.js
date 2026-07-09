/**
 * Cloudflare Pages Function — reemplazo de subir.php (Librería Ichinén)
 * Ruta: POST /admin/api   (se mapea sola por estar en functions/admin/api.js)
 *
 * Qué hace, en un solo paso y sin sesiones:
 *   1. Valida la contraseña del panel (secreto PANEL_CLAVE, NO va en el código).
 *   2. Recibe el .xlsx del formulario.
 *   3. Lo guarda en R2 SIEMPRE como "listado.xlsx" (bucket = binding DATOS).
 *   4. Dispara el workflow de GitHub para reconstruir el catálogo al instante
 *      (secreto GITHUB_TOKEN; el token queda del lado servidor, nunca en el navegador).
 *
 * Variables / bindings a configurar en Cloudflare Pages (Settings → Functions/Variables):
 *   PANEL_CLAVE     (secret)  contraseña del panel
 *   GITHUB_TOKEN    (secret)  fine-grained PAT con permiso Actions: read/write sobre el repo
 *   GITHUB_OWNER    (var)     ej. "serfalco"
 *   GITHUB_REPO     (var)     ej. "catalogo-ichinen"
 *   GITHUB_WORKFLOW (var)     ej. "catalogo.yml"
 *   GITHUB_REF      (var)     ej. "main"
 *   DATOS           (R2 binding) bucket donde se guarda listado.xlsx
 */

const MAX_MB = 25;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function dispararGitHub(env) {
  if (!env.GITHUB_TOKEN) return null; // sin token: el build igual corre en la semanal
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
  return r.status === 204; // GitHub responde 204 cuando aceptó el disparo
}

export async function onRequestPost({ request, env }) {
  // Validar contraseña temprano (sin filtrar por qué falla).
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

  // Guardar SIEMPRE con el nombre correcto.
  try {
    await env.DATOS.put("listado.xlsx", archivo.stream(), {
      httpMetadata: {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (e) {
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

// Cualquier otro método al endpoint: método no permitido.
export async function onRequest({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, mensaje: "Método no permitido." }, 405);
  }
}
