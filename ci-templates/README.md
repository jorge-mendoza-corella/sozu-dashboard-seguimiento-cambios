# Notificaciones WhatsApp (CI)

Dos notificaciones vía un webhook de n8n (header `apikey`). **La instancia, el
webhook, la apikey y el teléfono del admin ya no van escritos en el YAML**: se
leen de Firestore, de la configuración de la empresa dueña del repo, con el
default global como respaldo.

> ⚠️ Estos archivos van en `.github/workflows/`. El PAT del remote **no tiene
> scope `workflow`**, así que `git push` los rechaza. Commítealos desde el
> **editor web de GitHub** (github.com → el repo → Add file / Edit → Commit).
> El editor web usa tu sesión de navegador, no el PAT, y sí permite workflows.

---

## 0. De dónde sale la configuración

Todo se configura desde el dashboard, en **Configuración → Notificaciones**:
el default global y, por empresa, lo que quiera sobrescribir.

| Qué | Global | Por empresa |
| --- | --- | --- |
| Instancia, webhook, teléfono del admin, encendido | `settings/notifications` | `clients/{clientId}/private/notifications` |
| Apikey del webhook | `secrets/whatsapp.apiKey` | `clients/{clientId}/private/whatsappSecret.apiKey` |

Campos: `instance` (el `instanciaWA` del payload), `webhookUrl`, `adminPhone`
(E.164, con lada: `+5217221514185`) y `enabled` (booleano; ausente = prendido).

### Cascada

- Campo por campo: **el que la empresa tenga con valor gana**; el que esté vacío
  o ausente se hereda del global. Lo mismo con la apikey (si la empresa no tiene
  la suya, se usa la global).
- `enabled: false` en la empresa **o** en el global ⇒ no se manda nada. El job
  lo dice en el log y **termina en éxito**: apagar no es un error.
- Si al final falta el webhook o la apikey (ni la de la empresa ni la global):
  en el deploy se omite la notificación sin tumbar el deploy; en el workflow de
  PRs se avisa con `::error::` y falla **solo** el job de notificación, que es
  justo su propósito.

### Cómo se resuelve la empresa dueña del repo

Dos saltos en Firestore, con el `GITHUB_REPOSITORY` del propio job:

1. `repos/{owner}__{repo}` → campo `projectId`
   (el id del doc es `owner/repo` con la barra cambiada por `__`).
2. `projects/{projectId}` → campo `clientId`.

**Si el repo no está dado de alta**, o el proyecto no tiene empresa asignada, se
usa la configuración global y queda dicho en el log: el job **no falla**. Un repo
sin cliente sigue notificando como siempre.

### Apikeys en el log

La apikey se enmascara con `::add-mask::` en cuanto se lee de Firestore, así que
nunca aparece en los logs de Actions. **No la escribas en el YAML**: si ves un
`N8N_APIKEY: ...` en algún workflow, es de la versión vieja y hay que quitarlo
(y rotar esa apikey, que quedó en el historial de git).

---

## 1. Notificaciones de PR (abierto hacia `dev`, y cerrado hacia `dev`/`main`)

Archivo: [`notify-pr-dev.yml`](./notify-pr-dev.yml)

- **Abierto hacia `dev`** → avisa al admin (`adminPhone` de la empresa, o el
  global).
- **Cerrado hacia `dev` o `main`** (con o sin merge) → avisa a cada autor real del
  PR (teléfono en `contributors/{login}.telefonoWhatsapp`) y al admin.

Colócalo como `.github/workflows/notify-pr-dev.yml` en cada repo monitoreado:

- `jorgeIMendoza/sozu-cliente-app`
- `jorgeIMendoza/sozu-admin`
- `jorgeIMendoza/sozu-supabase-migrations`
- `jorgeIMendoza/sozu-edge-functions`
- `jorgeIMendoza/sozu-n8n-workflows`
- `jorgeIMendoza/sozu-mcp`
- `sozu-com/server-stp`

Los autores salen de las líneas `<!-- pr_author: login -->` que el dashboard
embebe en el body; si no hay ninguna, se usa el autor del PR en GitHub.

La resolución de la configuración vive en **un solo bloque** (`RESOLVER_WA`, una
variable de entorno del workflow con el script) que los tres jobs corren con
`bash -c "$RESOLVER_WA"` y que exporta a `$GITHUB_ENV`: `WA_INSTANCE`,
`WA_WEBHOOK`, `WA_APIKEY`, `WA_ADMIN`, `WA_ENABLED` y `WA_GCP_TOKEN` (el access
token, reusado en el mismo job para leer los teléfonos). Se escribió así —y no
como composite action— para no agregar actions ni dependencias entre jobs: cada
job resuelve lo suyo por su cuenta.

### Por qué no usa actions del marketplace

El 2026-08-06 el merge a `dev` de un PR en `sozu-cliente-app` no notificó a
nadie: el job murió en **Set up job** con `Failed to resolve action download
info. Error: Service Unavailable` al resolver `google-github-actions/auth` y
`setup-gcloud`. Eso pasa antes de cualquier step, así que los
`continue-on-error: true` de esos pasos no evitaron nada y el aviso al admin
—que solo necesitaba `curl`— cayó con ellos.

Ahora:

- El access token de Google se obtiene firmando un JWT con `openssl` a partir de
  `secrets.FIREBASE_GCP_DEV`. Solo se usan `curl`, `jq` y `openssl`, que ya
  vienen en el runner: cero actions de terceros que resolver.
- El aviso al admin vive en su propio job (`notify-cerrado-admin`), así que un
  problema leyendo teléfonos ya no puede silenciarlo.
- Los envíos al webhook reintentan 3 veces y el job falla si ninguno entra: un
  aviso perdido queda visible en Actions en lugar de desaparecer.
- Todos los jobs tienen `timeout-minutes` (el job cancelado se quedó 15 min
  colgado antes de morir).

---

## 2. Deploy del dashboard terminado → avisa a quien lo generó

Ya está agregado en `.github/workflows/deploy.yml` de **este** repo (paso
`Notificar deploy listo (WhatsApp)`). Si el push falla por el scope del token,
agrega ese paso vía editor web.

Ese paso hace lo mismo que el bloque `RESOLVER_WA`, pero como este repo ya se
autenticó antes con `gcloud`, el token sale de `gcloud auth print-access-token`
en lugar de firmar el JWT a mano. Mantiene `continue-on-error: true`: si algo
falta o n8n no responde, el deploy —que ya quedó publicado— no se marca en rojo.

```yaml
      - name: Notificar deploy listo (WhatsApp)
        if: success()
        continue-on-error: true
        env:
          ENVIRONMENT: DEV
          FIRESTORE_PROJECT: sozu-admin-dev
        run: |
          ACCESS_TOKEN="$(gcloud auth print-access-token)"
          # repos/{owner__repo}.projectId -> projects/{projectId}.clientId, y de
          # ahí clients/{clientId}/private/{notifications,whatsappSecret};
          # lo vacío se hereda de settings/notifications y secrets/whatsapp.
          # ... (ver el archivo completo)
          curl -s -X POST "$WA_WEBHOOK" \
            -H "apikey: $WA_APIKEY" \
            -H "Content-Type: application/json" \
            -d "$PAYLOAD"
```

### Cómo arma el teléfono
`+521` + los 10 dígitos guardados en Firestore (`contributors/{githubLogin}.telefonoWhatsapp`),
buscando por `github.actor` (quien disparó el deploy). Los teléfonos de los
contribuidores **no** son parte de la configuración por empresa: siguen en
`contributors/`.

### Requisitos
- El service account `FIREBASE_GCP_DEV` debe poder **leer Firestore** (rol
  `Cloud Datastore User` o `Firebase Viewer`). La lectura por REST con el token
  del SA ignora las reglas de seguridad (acceso admin) — por eso puede leer los
  docs de `secrets/` y `clients/{id}/private/`, que el navegador tiene prohibidos.
- El usuario que pushea debe tener su teléfono guardado en la pestaña
  **Contribuidores**, bajo su login exacto de GitHub.
- La empresa (o el global) debe tener webhook y apikey guardados en
  **Configuración → Notificaciones**.
