# Notificaciones WhatsApp (CI)

Dos notificaciones vía el webhook de n8n
(`https://automatizacion-n8n.fbqqbe.easypanel.host/webhook/manda_notificacion`,
header `apikey`).

> ⚠️ Estos archivos van en `.github/workflows/`. El PAT del remote **no tiene
> scope `workflow`**, así que `git push` los rechaza. Commítealos desde el
> **editor web de GitHub** (github.com → el repo → Add file / Edit → Commit).
> El editor web usa tu sesión de navegador, no el PAT, y sí permite workflows.

---

## 1. Notificaciones de PR (abierto hacia `dev`, y cerrado hacia `dev`/`main`)

Archivo: [`notify-pr-dev.yml`](./notify-pr-dev.yml)

- **Abierto hacia `dev`** → avisa al admin (número fijo `+5217221514185`).
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
agrega ese paso vía editor web. El paso es:

```yaml
      - name: Notificar deploy listo (WhatsApp)
        if: success()
        env:
          ENVIRONMENT: DEV
          N8N_WEBHOOK: https://automatizacion-n8n.fbqqbe.easypanel.host/webhook/manda_notificacion
          N8N_APIKEY: 80FA62E3FD0C-4477-8B31-8A2CD6AF7B57
        run: |
          ACTOR="${{ github.actor }}"
          ACCESS_TOKEN="$(gcloud auth print-access-token)"
          PHONE="$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
            "https://firestore.googleapis.com/v1/projects/sozu-admin-dev/databases/(default)/documents/contributors/${ACTOR}" \
            | jq -r '.fields.telefonoWhatsapp.stringValue // empty')"
          if [ -z "$PHONE" ]; then
            echo "Sin teléfono guardado para '$ACTOR'; se omite."
            exit 0
          fi
          curl -s -X POST "$N8N_WEBHOOK" \
            -H "apikey: $N8N_APIKEY" \
            -H "Content-Type: application/json" \
            -d "{\"tipo\":\"wa\",\"telefono\":\"+521${PHONE}\",\"mensajeWA\":\"Ha quedado listo tu deploy en ${ENVIRONMENT}, puedes revisar\",\"instanciaWA\":\"Pruebas de todo\"}"
```

### Cómo arma el teléfono
`+521` + los 10 dígitos guardados en Firestore (`contributors/{githubLogin}.telefonoWhatsapp`),
buscando por `github.actor` (quien disparó el deploy).

### Requisitos
- El service account `FIREBASE_GCP_DEV` debe poder **leer Firestore** (rol
  `Cloud Datastore User` o `Firebase Viewer`). La lectura por REST con el token
  del SA ignora las reglas de seguridad (acceso admin).
- El usuario que pushea debe tener su teléfono guardado en la pestaña
  **Contribuidores**, bajo su login exacto de GitHub.

---

## Recomendado: mover el apikey a secret

En lugar de dejar `N8N_APIKEY` en texto, créalo como secret del repo/org y usa
`${{ secrets.N8N_APIKEY }}`.
