# Notificaciones WhatsApp (CI)

Dos notificaciones vía el webhook de n8n
(`https://automatizacion-n8n.fbqqbe.easypanel.host/webhook/manda_notificacion`,
header `apikey`).

> ⚠️ Estos archivos van en `.github/workflows/`. El PAT del remote **no tiene
> scope `workflow`**, así que `git push` los rechaza. Commítealos desde el
> **editor web de GitHub** (github.com → el repo → Add file / Edit → Commit).
> El editor web usa tu sesión de navegador, no el PAT, y sí permite workflows.

---

## 1. PR abierto hacia `dev` (desde fuera) → avisa al admin

Archivo: [`notify-pr-dev.yml`](./notify-pr-dev.yml)
Destino: número fijo `+5217221514185`.

Colócalo como `.github/workflows/notify-pr-dev.yml` en cada repo monitoreado:

- `jorgeIMendoza/sozu-admin`
- `jorgeIMendoza/sozu-supabase-migrations`
- `jorgeIMendoza/sozu-edge-functions`
- `jorgeIMendoza/sozu-n8n-workflows`
- `sozu-com/server-stp`

Variables: `$repositorio` = `github.event.repository.name`, `$quien_genera` = `github.actor`.

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
