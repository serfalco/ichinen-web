# Migración de Ichinén — de Hostinger/PHP a Cloudflare Pages

Esta carpeta es un proyecto **listo para desplegar en Cloudflare Pages**. Reemplaza
por completo la parte que hoy vive en Hostinger (la home `ichinen.com.ar` y el panel
de subida en PHP), sin tocar el catálogo, que sigue en GitHub Pages.

El objetivo puntual: que una persona **sin cuenta de GitHub y sin conocimientos**
pueda seguir subiendo el Excel exactamente igual que hoy — entra al panel, pone la
contraseña, arrastra el archivo y listo.

---

## 0. Antes que nada: seguridad

El `subir.php` viejo tenía **pegado el token de GitHub y la contraseña** en texto plano.

1. Entrá a GitHub → **Settings → Developer settings → Personal access tokens** y
   **revocá el token** `github_pat_11ANNWH6…`. (No rompe nada: el build semanal usa
   el token propio de Actions, no ese.)
2. Vas a generar uno nuevo más abajo, que queda guardado como secreto en Cloudflare,
   **nunca dentro de un archivo**.
3. Cambiá también la contraseña del panel (antes era `ichinen2027`).

---

## 1. Cómo queda la arquitectura

| Pieza | Antes | Después |
|---|---|---|
| Home `ichinen.com.ar` | Hostinger (estático) | **Cloudflare Pages** (estático) |
| Panel de subida | `subir.php` (PHP) | **Cloudflare Function** `functions/admin/api.js` |
| El Excel subido | `datos/listado.xlsx` en Hostinger | **Cloudflare R2** (`listado.xlsx`) |
| Catálogo `catalogo.ichinen.com.ar` | GitHub Pages | **GitHub Pages (igual, sin cambios)** |
| Build del catálogo | GitHub Actions bajando el Excel de Hostinger | GitHub Actions bajando el Excel **de R2** |

El único cambio del lado del catálogo es **de dónde baja el Excel** (la variable
`EXCEL_URL`). El motor en Python no se toca.

Flujo cuando el dueño sube un Excel:

```
Panel /admin  →  Function /admin/api  →  guarda listado.xlsx en R2
                                     └→  dispara el workflow de GitHub (workflow_dispatch)
GitHub Actions  →  baja listado.xlsx desde R2  →  reconstruye el catálogo  →  publica
```

---

## 2. Estructura de esta carpeta

```
ichinen-cloudflare/
├── public/                     ← lo que sirve Cloudflare Pages (la web)
│   ├── index.html              home (igual que la actual)
│   ├── css/ js/ img/           assets de la home
│   ├── robots.txt  sitemap.xml
│   └── admin/
│       ├── index.html          el panel (contraseña + subida + prelimpieza)
│       ├── prelimpieza.js      motor de limpieza en el navegador (igual que hoy)
│       └── xlsx.full.min.js    librería SheetJS
└── functions/
    └── admin/
        └── api.js              reemplazo de subir.php (valida clave, guarda en R2, dispara build)
```

---

## 3. Pasos en Cloudflare (una sola vez)

Todo esto lo hace la persona técnica; el dueño no necesita nada de esto.

### 3.1 Cuenta y dominio
1. Creá una cuenta gratis en https://dash.cloudflare.com
2. **Add a site** → `ichinen.com.ar`. Cloudflare te va a dar dos *nameservers*.
3. En el registrador del dominio (donde comprás/renovás `ichinen.com.ar`), cambiá los
   nameservers por los de Cloudflare. Esto mueve el DNS a Cloudflare (tarda de minutos
   a unas horas en propagar).

### 3.2 Que el catálogo siga funcionando
En Cloudflare → **DNS**, asegurate de que exista este registro (para no romper el subdominio):
- Tipo `CNAME`, nombre `catalogo`, destino `serfalco.github.io`, **Proxy: DNS only (nube gris)**.

> Importante: gris (DNS only), no naranja. GitHub Pages maneja su propio HTTPS.

### 3.3 Bucket R2 (donde vive el Excel)
1. Cloudflare → **R2** → *Create bucket* → nombre `ichinen-datos`.
   (R2 tiene capa gratuita amplia; puede pedirte agregar un medio de pago sin cobro.)
2. Habilitá acceso público al bucket: la opción más simple es el dominio **`r2.dev`**
   que te da Cloudflare, o conectar un subdominio propio como `datos.ichinen.com.ar`.
3. Anotá la URL pública del archivo, va a quedar tipo:
   `https://<algo>.r2.dev/listado.xlsx`  ó  `https://datos.ichinen.com.ar/listado.xlsx`

### 3.4 Crear el proyecto Pages
Cualquiera de las dos vías:
- **Subida directa:** Cloudflare → **Workers & Pages** → *Create* → *Pages* → *Upload assets*,
  y subís el contenido de la carpeta `public/`. (Las Functions van aparte, mejor por Git.)
- **Recomendado — conectar a Git:** subí esta carpeta a un repo (ej. `serfalco/ichinen-web`)
  y en Pages elegí *Connect to Git*. Configuración de build:
  - Framework preset: **None**
  - Build command: *(vacío)*
  - Build output directory: **`public`**

  Al conectar por Git, Cloudflare detecta la carpeta `functions/` sola y publica la Function.

### 3.5 Binding de R2 y variables
En el proyecto Pages → **Settings → Functions** (o *Bindings*):
- **R2 bucket binding:** nombre de variable `DATOS` → bucket `ichinen-datos`.

En **Settings → Variables and Secrets**, agregá:

| Nombre | Tipo | Valor |
|---|---|---|
| `PANEL_CLAVE` | Secret | la contraseña nueva del panel |
| `GITHUB_TOKEN` | Secret | PAT nuevo (ver 3.6) |
| `GITHUB_OWNER` | Variable | `serfalco` |
| `GITHUB_REPO` | Variable | `catalogo-ichinen` |
| `GITHUB_WORKFLOW` | Variable | `catalogo.yml` |
| `GITHUB_REF` | Variable | `main` |

### 3.6 Token nuevo de GitHub (para disparar el build)
GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens** →
*Generate new token*:
- Repository access: solo `serfalco/catalogo-ichinen`
- Permisos: **Actions → Read and write**
- Copiá el token y pegalo en el secreto `GITHUB_TOKEN` de Cloudflare (paso 3.5).

### 3.7 Dominio de la home en Pages
Proyecto Pages → **Custom domains** → *Set up a domain* → `ichinen.com.ar`
(y opcionalmente `www.ichinen.com.ar`). Como el DNS ya está en Cloudflare, se
configura solo.

---

## 4. Cambio en el repo del catálogo (un solo valor)

GitHub → repo `catalogo-ichinen` → **Settings → Secrets and variables → Actions →
pestaña Variables** → editá `EXCEL_URL`:

```
Antes:   https://ichinen.com.ar/datos/listado.xlsx
Después: https://<tu-bucket>.r2.dev/listado.xlsx   (la URL del paso 3.3)
```

Nada más. El motor (`motor/build.py`) baja el Excel de ahí y sigue igual.

---

## 5. Probar antes de apagar Hostinger

1. Entrá a `https://ichinen.com.ar/admin/` → probá una contraseña mal (debe rechazar)
   y después la correcta con un `.xlsx` de prueba.
2. Verificá que el archivo aparezca en el bucket R2 como `listado.xlsx`.
3. Mirá GitHub → pestaña **Actions**: tiene que haberse disparado "Actualizar catálogo".
4. Cuando termine, revisá `https://catalogo.ichinen.com.ar` actualizado.
5. Revisá que la home `https://ichinen.com.ar` se vea bien (logo, mapa, links).

Recién cuando todo esto funcione, **das de baja el hosting de Hostinger**. El dominio
puede seguir registrado donde está; lo único que cambió son los nameservers (DNS).

---

## 6. Notas

- El panel `/admin/` lleva `noindex` y la subida real está protegida por contraseña,
  igual que antes. La contraseña se valida **en el servidor** (la Function), no en el navegador.
- La prelimpieza en el navegador (tapas equivocadas, fichas repetidas, posibles
  repetidos) quedó **idéntica**: es opcional y no bloquea.
- Si algún día no querés depender de R2, se puede cambiar la Function para que
  commitee el Excel directo al repo vía la API de GitHub; avisá y lo adapto.
- El build del catálogo también corre solo cada lunes, así que aunque el disparo
  instantáneo fallara, la web se actualiza igual en la semana.
```
