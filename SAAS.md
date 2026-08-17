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

## Colecciones nuevas en Firestore

| Ruta | Contenido | Reglas |
| --- | --- | --- |
| `clients/{id}` | identidad y features contratadas | lee cualquier usuario registrado; escribe solo el root |
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

## Estructura inicial

Configuración → Clientes → "Sembrar" corre `seedSaasStructure`
(`src/lib/saasSeed.ts`): crea Vectis, Sozu, Monocolo y Mutuo, renombra el
proyecto histórico `SOZU` a **Admin** y da de alta Landings, Sozu Clientes APP y
Sozu Agentes APP bajo el cliente Sozu, que arranca con las dos features
prendidas (es la casa: ya publica apps y ve los avances). Es idempotente: se
puede correr de nuevo y solo completa lo que falte.

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
