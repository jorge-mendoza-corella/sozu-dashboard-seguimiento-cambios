# Modelo SaaS del dashboard

Cómo está armado el cobro del servicio y qué falta para facturar de verdad.

## Jerarquía

```
clients/{id}                      cliente que paga (empresa o persona física)
  ├─ private/billing              datos fiscales y tarifas (solo superusers)
  └─ projects/{id}.clientId       proyectos del cliente
       └─ repos/{id}              repos del proyecto  ← esto es lo que se cobra
```

Un cliente tiene varios proyectos y cada proyecto varios repos. La unidad de
cobro es el **repo**: el mes de un cliente es la suma de sus repos más las
features extra que tenga contratadas.

## Cascada de precios

El precio mensual de un repo se resuelve en este orden y gana el primero que
exista:

1. `repos/{id}.monthlyPrice` — precio fijado a ese repo en particular
2. `clients/{id}.billing.pricePerRepo` — tarifa del cliente
3. `settings/billing.defaultPricePerRepo` — default global

Encima se suman los extras contratados, se aplica el descuento del cliente
(`billing.discountPct`) y al final el IVA (`settings/billing.taxRatePct`, o 0 si
el cliente es `taxExempt`). Todo el cálculo vive en `src/lib/billing.ts`, en
funciones puras sin Firestore: `computeClientBilling` y `computeBillingOverview`.

**Los defaults globales están expresados en la moneda global.** Un cliente que
factura en otra moneda no los hereda —serían pesos cobrados como dólares—: sus
repos quedan con `source: "sin-precio"` en 0 hasta que se les fije tarifa propia,
y el panel de Negocio lo levanta como alerta (`overview.currencyMismatch`).

## Features de pago por cliente

En `clients/{id}.features`:

| Feature | Campo | Costo extra |
| --- | --- | --- |
| Ver sus avances | `showAvances` + `avancesUrl` | `avancesPrice`, o `settings/billing.defaultAvancesPrice` |
| Publicar apps en tiendas | `publishApps` | `publishAppsPrice`, o `settings/billing.defaultPublishAppsPrice` |

Dónde se aplican:

- **Avances**: `useAvancesAccess` decide si el link aparece en la navegación y a
  qué URL apunta. El root siempre lo ve. Los usuarios sin `projectIds` (legacy,
  ven todo el dashboard) conservan el acceso que ya tenían.
- **Publicar apps**: `useCanPublishApps` apaga la pestaña "Deploy App" del
  proyecto cuando su cliente no lo tiene contratado. Un proyecto **sin cliente**
  sí puede publicar, para no romper los proyectos que aún no se han asignado.

Los dos gates **fallan abierto** mientras la lista de clientes no haya cargado:
apagar el deploy de todos por un fetch lento sería peor que dejarlo pasar.

> **Los dos son de UI, no de servidor.** El link de avances solo se esconde; el
> sitio `avances.sozu.com` no valida nada, así que quien conozca la URL entra. Y
> los builds de apps se disparan contra Codemagic con un token que va en el
> bundle, así que la pestaña escondida no impide publicar. Para que el cobro se
> pueda hacer valer, publicar tiene que pasar por una función de servidor que lea
> `clients/{id}/private/billing` con cuenta de servicio.

## Roles

| Rol | Qué manda |
| --- | --- |
| Superusuario raíz (`jorge.mendoza@sozu.com`) | todo, y es el único que crea clientes, mueve tarifas y toca datos fiscales |
| `superuser` — Administrador global | ve y opera todo el servicio |
| `client_admin` — Administrador de empresa | sus empresas (`clientIds`): proyectos, repos, viewers y notificaciones. No ve otras empresas |
| `viewer` | los proyectos que se le asignen (`projectIds`) |

Un `client_admin` ve **todos** los proyectos de sus empresas, sin necesidad de
listarlos en `projectIds`: son suyos por pertenecer a la empresa. El recorte de
pantallas sale de `useClientScope`, y las reglas de Firestore repiten el mismo
corte para que esconder no sea la única defensa:

- Crea, edita y borra **solo viewers** de sus empresas (`administraTodas` exige
  que las dos puntas del cambio —la empresa que tenía y la que queda— sean suyas).
- Escribe proyectos y repos de sus empresas, pero **no `monthlyPrice`**: ese
  campo es lo que se le cobra a su propia empresa, así que solo lo mueve el root.
- Lee y escribe `clients/{id}/private/notifications`, y nada más de la
  subcolección privada de otros clientes.

> Cuidado con `hasOnly` en las reglas: `[].hasOnly([])` es verdadero, así que
> toda comprobación exige además que ambas listas traigan algo. Sin ese guardia,
> cualquier usuario autenticado podía escribir los docs legacy sin empresa.

## White label

Cada empresa ve la herramienta con su marca: nombre del producto, logo, favicon,
color y una frase. Vive en `clients/{id}.branding` —doc raíz, porque lo necesita
cualquiera que pertenezca a la empresa, y un logo no es secreto— y lo edita el
root o el administrador de esa empresa (las reglas le permiten esa llave y nada
más del documento, con `hasOnly(['branding'])`).

El color se aplica pisando las variables de shadcn (`--primary`, `--ring`) en el
elemento raíz, así que tiñe toda la interfaz sin tocar un componente. El texto
sobre el color se calcula por luminancia (WCAG): con una marca clara, el blanco
de siempre sería ilegible.

`resolveBranding` aplica la marca **solo cuando el usuario ve una única empresa
con marca**. Quien administra varias —o el equipo interno, que ve todas— se queda
con la del proveedor: pintarle la marca de una haría creer que está viendo nada
más esa cuenta.

### El login, por dominio

La pantalla de entrada no sabe quién está entrando, así que su marca no puede
salir del usuario. El root la publica por dominio en `public_branding/{hostname}`
y el login la lee sin sesión. Es la **única** colección con `allow read: if true`,
y por eso solo lleva nombre, logo, color y el id del cliente.

Sin doc para ese host, el login se queda con la marca del proveedor. Un cliente
con su propio dominio apuntado al hosting ve su marca desde la puerta.

## Credenciales de tienda por app

Cada proyecto APP publica con SU propia cuenta de tienda, así que sus
credenciales son suyas y no se comparten:

| Ruta | Contenido |
| --- | --- |
| `projects/{id}/private/playSecret` | service account de Google Play |
| `projects/{id}/private/ascSecret` | llave de App Store Connect (`keyId`, `issuerId`, `privateKey`) |
| `storeCredentials/{play,appStoreConnect}` | las globales de antes, ahora solo respaldo |

Los secretos tienen `allow read: if false`: desde el navegador se escriben y
nunca se leen, ni el root. Lo visible es el rastro —`playCredentialsUpdatedAt/By`
y `ascCredentialsUpdatedAt/By` en el doc del proyecto—, que es lo que la interfaz
muestra para saber que ya están puestas.

Los syncs resuelven por proyecto, y en este orden: **el doc privado del proyecto
→ el entorno (Secret Manager) → el global heredado**. El entorno dejó de ganar a
propósito: la credencial del proyecto es la que identifica a esa app, y si el
entorno la tapara volveríamos a tener una sola credencial para todos. Un proyecto
sin credencial por ninguna vía no tumba el sync: queda su error en el doc de la
tienda y los demás siguen.

### Migración

`python ci/migrate_store_credentials.py` copia las credenciales globales a cada
proyecto APP —arrancando por Sozu Clientes APP y Sozu Agentes APP, que hoy usan
la misma— para que nadie se quede sin publicar mientras se les cargan las suyas.
Es idempotente y no pisa lo que ya tenga valor (`--force` para forzar,
`--dry-run` para ver qué haría). Solo puede correr con cuenta de servicio: los
secretos no se pueden leer desde el navegador, así que la copia no se puede hacer
desde el dashboard.

Después de migrar, lo pendiente es **darle a cada app su propia cuenta de tienda**:
mientras compartan el service account, un acceso a Play Console alcanza para las
dos.

## Notificaciones de WhatsApp

Los avisos de PR y de deploy salen por un webhook de n8n. Antes había una sola
instancia y una sola apikey escritas en el YAML: todas las empresas compartían
número. Ahora es **por empresa o nada** — no hay default global:

| Ruta | Contenido |
| --- | --- |
| `clients/{id}/private/notifications` | instancia, webhook y `enabled` |
| `clients/{id}/private/whatsappSecret` | apikey (`allow read: if false`) |

No existe `settings/notifications` ni `secrets/whatsapp`, y esa ausencia es la
decisión: con un default global, la empresa que todavía no configuró sus avisos
los recibía por el número de otra, y su webhook podía acabar llevándose una llave
que no era suya. Sin nada que heredar, esos dos problemas no existen.

Los workflows resuelven la empresa desde el repo:
`repos/{owner}__{repo}.projectId` → `projects/{id}.clientId` → config del cliente.
Si el repo no está dado de alta, o su proyecto no tiene empresa, o la empresa no
tiene sus datos, **no se manda nada** y el log dice exactamente qué falta. Eso no
falla el job: una empresa sin configurar es un pendiente del dashboard, no una
avería del CI.

La instancia, el webhook y el teléfono que traían los workflows son de Sozu, así
que la siembra los pone en la empresa Sozu (y en Vectis, que hoy comparte la
instancia). La apikey no se siembra: es un secreto y se captura a mano.

### Fin de build (Android e iOS)

El aviso de "tu build terminó" dependía del `codemagic.yaml` de cada repo de app:
el dashboard le inyectaba `WA_PHONE` y el propio workflow mandaba el mensaje al
final. Eso dejaba fuera justo el caso que importa —el build que revienta antes de
llegar a ese paso—, y un build de iOS falló sin avisarle a nadie.

Ahora avisa `ci/codemagic_builds_notify.py`, programado cada 5 minutos: le
pregunta a Codemagic cómo terminó cada build y manda el WhatsApp él mismo, con
éxito o con fallo, sin depender de que el build llegue vivo a ningún paso.

Lo único que ese sync no puede deducir es quién lo disparó: el dashboard lo deja
al lanzarlo en `buildNotifications/{buildId}`, que además sirve de marca de
idempotencia. Desde el navegador ese doc solo se CREA — marcarlo como notificado
es cosa del sync, porque si no cualquiera podría dar por avisado un fallo del que
nadie se enteró. Un build lanzado desde Codemagic directo también avisa: sin doc
previo, el sync lo crea y manda el mensaje al teléfono administrativo.

**A quién le llega no se configura**: los avisos van a las personas. Al autor o
a quien disparó el build, y al **aprobador del proyecto** —de
`projects/{id}.approverEmail`, resolviendo su teléfono por
`users/{email}.githubLogin` → `contributors/{login}.telefonoWhatsapp`—. Lo que se
configura por empresa es por dónde salen: instancia, webhook y apikey.

## Colecciones nuevas en Firestore

| Ruta | Contenido | Reglas |
| --- | --- | --- |
| `clients/{id}` | identidad, features y marca | lo lee quien pertenece a esa empresa; escribe el root (su marca, también su administrador) |
| `public_branding/{hostname}` | marca del login por dominio | **lectura pública**; escribe solo el root |
| `clients/{id}/private/billing` | datos fiscales y tarifas | lee solo superusers; escribe solo el root |
| `settings/billing` | defaults globales y metadatos de Facturapi | lee cualquier usuario registrado; escribe solo el root |
| `secrets/facturapi` | la API key de Facturapi | `allow read: if false` — no se lee desde el navegador |

El doc raíz del cliente lo lee cualquier usuario registrado a propósito:
`AppLayout` carga la lista en **cada página** para saber si pinta el link de
avances. Por eso el RFC, el domicilio y las tarifas viven en el doc privado —
dejarlos arriba los mandaba al navegador de todos los usuarios. En código son dos
hooks distintos: `useClients()` (público, barato) y `useClientsBilling()` (una
lectura extra por cliente, solo en Negocio y Configuración).

`secrets/facturapi` bloquea la lectura desde el navegador, pero **no está
cifrada**: la consola de Firebase y cualquier cuenta de servicio del proyecto
—incluida la de los workflows de `.github/workflows/`— pueden leerla. Para
`sk_live_` eso significa poder timbrar CFDI reales, así que la fase 2 debe moverla
a Secret Manager, igual que las credenciales de tienda.

## Alta de clientes y proyectos

Configuración → **Clientes**: se crean ahí, y el chip de proyectos de cada uno
despliega los suyos para renombrarlos, marcarlos como app, sacarlos de la empresa
o dar de alta uno nuevo. La pestaña **Proyectos y repos** es la misma estructura
vista al revés —todos los proyectos con sus repos y sus precios— y es donde se
mueven los repos entre proyectos.

Hubo un botón "Sembrar" que creaba de golpe los cuatro clientes iniciales y los
proyectos de Sozu. Se quitó al terminar la migración: existía para llegar a este
estado, y dejarlo invitaba a re-sembrar sobre una estructura que ya se administra
a mano.

## Avisos de WhatsApp al admin global

El dueño del servicio no es autor ni aprobador de casi nada, así que por el
camino normal no le llega nada de la cartera: se enteraba de los cambios de un
cliente solo si alguien se lo contaba. Ahora puede suscribirse a todos los
repos, en **Usuarios → su propia fila → Avisos de WhatsApp**.

Es **opt-in** y se guarda en `users/{email}.avisaDeTodosLosRepos`. Apagado por
defecto porque son todos los movimientos de todos los repos, y eso encendido sin
pedirlo es una avalancha.

Lo escribe cada quien sobre su propio documento —las reglas dejan tocar ese
campo y la API key, nada más—, y por eso también aparece solo en la fila propia:
ofrecerlo en la de otro sería prometer un guardado que Firestore rechaza.

La copia sale por la instancia de la **empresa dueña de cada repo**, no por una
global (no hay ninguna). Eso mantiene la regla: si esa empresa tiene los avisos
apagados, tampoco se manda la copia. Y no se duplica: cuando el suscrito ya era
autor o aprobador de ese PR, recibe un solo mensaje.

Su teléfono sale de Contribuidores, igual que el de todos.

## Qué se avisó de cada deploy

El dashboard puede **calcular** a quién le toca un aviso —el aprobador del
proyecto, los suscritos, la configuración de la empresa—, pero no si el mensaje
salió: un teléfono sin capturar, una instancia de WhatsApp caída o una empresa
apagada cambian el resultado sin cambiar nada de lo que se ve desde la interfaz.

Por eso el propio deploy anota lo que hizo, con su cuenta de servicio, en
`deployNotifications/{owner}__{repo}__{runId}`: a quién le llegó, a quién no y
por qué. El navegador solo lo lee — si pudiera escribirlo dejaría de ser
evidencia de lo que pasó y sería otra cosa que alguien afirmó.

El tooltip de cada deploy en CI/CD lo usa así:

- **con registro** — «Se avisó a @x», y en ámbar cada destinatario que falló con
  su motivo. Un aviso que no llegó importa más que los que sí: nadie va a abrir
  el log del workflow para enterarse.
- **corriendo** — «Al terminar se avisará a…», porque el aviso sale al final del
  workflow y decirlo en pasado sería afirmar algo que todavía no pasó.
- **sin registro** (deploys anteriores a esto, o repos cuyo workflow aún no
  anota) — «Le tocaba el aviso a…», en condicional y diciendo que no dejó
  registro, en vez de inventar una entrega.

## Facturapi — qué falta (fase 2)

Lo que ya está: la Secret Key se guarda en `secrets/facturapi`, se valida su
formato (`sk_test_…` / `sk_live_…`), se detecta el entorno y se guarda la serie
de los CFDI. Los campos fiscales del cliente usan los mismos nombres que el
payload de Facturapi (`legalName` → `legal_name`, `taxId` → `tax_id`,
`taxSystem` → `tax_system`, `fiscal.zip` → `address.zip`) para que el mapeo sea
directo.

Lo que falta:

1. **Cliente en Facturapi**: `POST /v2/customers` con los datos fiscales y
   guardar el id devuelto en `clients/{id}.facturapiCustomerId`.
2. **Timbrar**: `POST /v2/invoices` con un concepto por repo (o uno agregado por
   proyecto) usando el desglose que ya devuelve `computeClientBilling`.
3. **Correr desde el servidor**: la API key no puede salir del navegador, así que
   la emisión tiene que vivir en un job/Cloud Function que la lea de
   `secrets/facturapi` con cuenta de servicio — el mismo patrón que los syncs de
   tiendas en `ci/`.
4. **Histórico**: una colección `invoices/{id}` con lo timbrado, para dejar de
   proyectar el MRR linealmente en el panel de Negocio y graficar lo real.

Documentación: <https://docs.facturapi.io/>
