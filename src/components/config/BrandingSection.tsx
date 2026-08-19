import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Palette, Building2, Globe, Upload, Trash2, RotateCcw, Send, ImageOff, Eye,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useClients, useClientScope } from "@/hooks/useClients";
import { usePublicBranding } from "@/hooks/useBranding";
import { isRootAdmin } from "@/lib/firestoreUsers";
import { clientDisplayName, type Client } from "@/lib/firestoreClients";
import {
  foregroundForHex, brandTriplet, setClientBranding, setPublicBranding, VENDOR_BRANDING,
  VENDOR_SIGNATURE,
  type ClientBranding, type PublicBranding,
} from "@/lib/branding";

// ---------------------------------------------------------------------------
// Marca por empresa (white label): que cada cliente vea la herramienta como si
// fuera suya — su nombre, su logo, su color — y no la del proveedor.
//
// Una card por empresa de `visibleClients`, que para un administrador de empresa
// son SOLO las suyas: así el cliente se pinta su propia marca sin que nadie del
// equipo interno tenga que hacerlo por él. Todo guarda al salir del campo
// (blur), igual que Notificaciones; las validaciones (nombre de 40, frase de 90,
// hex, peso de la imagen) viven en `setClientBranding` y aquí solo se pinta el
// error que lanza.
//
// El logo se puede dar de dos formas porque hay clientes sin ningún lugar donde
// subir un archivo: una URL https, o el archivo mismo leído a data URI y
// guardado en el doc. Lo segundo tiene tope (un doc de Firestore no pasa de
// 1 MB), y por eso el tamaño se revisa aquí antes de intentar el guardado.
//
// La vista previa aplica el color SOLO a su propio contenedor, pisando ahí las
// variables de shadcn. Aplicarlo a toda la interfaz es trabajo de
// `useApplyBranding`: si esta pantalla lo hiciera al escribir, el dashboard
// completo cambiaría de color mientras alguien todavía está probando colores.
// ---------------------------------------------------------------------------

/** Formatos que aceptamos embebidos: los mismos que valida la capa de datos. */
const TIPOS_IMAGEN = "image/png,image/jpeg,image/webp,image/svg+xml";

/** Tope del archivo antes de embeberlo. Igual al de `setClientBranding`. */
const MAX_ARCHIVO_BYTES = 200 * 1024;

/** El `--primary` del tema (221.2 83.2% 53.3%), para cuando no hay color propio. */
const COLOR_DEFAULT = "#2563eb";

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** `#abc` / `abc123` → `#abc123`. Vacío se queda vacío (= volver al default). */
const normalizaHex = (v: string) => {
  const t = v.trim();
  if (!t) return "";
  return (t.startsWith("#") ? t : `#${t}`).toLowerCase();
};

/** `<input type="color">` solo entiende `#rrggbb`; cualquier otra cosa → default. */
const hexParaPicker = (v: string) => {
  const n = normalizaHex(v);
  return /^#[0-9a-f]{6}$/.test(n) ? n : COLOR_DEFAULT;
};

/**
 * Archivo → data URI. `FileReader` es lo único que permite embeber una imagen
 * sin tener un bucket donde subirla, que es justo el caso de los clientes que no
 * tienen hosting propio.
 */
const leerDataUri = (archivo: File) =>
  new Promise<string>((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
    lector.onload = () => {
      const r = lector.result;
      if (typeof r !== "string") {
        reject(new Error("No se pudo leer el archivo como imagen."));
        return;
      }
      resolve(r);
    };
    lector.readAsDataURL(archivo);
  });

/** Metadatos de los dos campos de imagen, que comparten toda la interfaz. */
const IMAGENES = {
  logoUrl: {
    label: "Logo",
    ayuda: "Se muestra en la barra superior y en el login. Ideal horizontal y con fondo transparente.",
    vacio: "Sin logo: en la barra se muestra solo el nombre.",
  },
  faviconUrl: {
    label: "Favicon",
    ayuda: "Icono de la pestaña del navegador. Cuadrado, 64×64 o más.",
    vacio: "Sin favicon propio: se usa el logo.",
  },
} as const;

type CampoImagen = keyof typeof IMAGENES;

export function BrandingSection() {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { visibleClients } = useClientScope(appUser);
  const { isLoading } = useClients(appUser);
  // La marca por dominio la publica solo el root: es quien sabe qué dominio es
  // de qué empresa, y ese doc lo lee cualquiera sin sesión.
  const esRoot = isRootAdmin(appUser);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Hex en captura por empresa. Vive aparte del valor guardado para que el
  // picker y el campo de texto se muevan juntos mientras se prueba un color,
  // sin escribir a Firestore en cada arrastre del selector.
  const [colores, setColores] = useState<Record<string, string>>({});
  // Formulario de marca por dominio (solo root).
  const [dominio, setDominio] = useState(
    typeof window === "undefined" ? "" : window.location.hostname,
  );
  const [dominioClientId, setDominioClientId] = useState("");

  const { data: publicada, isLoading: cargandoPublica } = usePublicBranding();
  const hostActual = typeof window === "undefined" ? "" : window.location.hostname;

  const refrescarClientes = () => qc.invalidateQueries({ queryKey: ["clients"] });
  /** La marca pública cuelga de otro query key: hay que tirar los dos. */
  const refrescarPublica = async () => {
    await qc.invalidateQueries({ queryKey: ["clients"] });
    await qc.invalidateQueries({ queryKey: ["public-branding"] });
  };

  const run = async (key: string, fn: () => Promise<unknown>, after: () => Promise<unknown> | void) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await after();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  const guardar = (key: string, clientId: string, patch: ClientBranding) =>
    run(key, () => setClientBranding(clientId, patch), refrescarClientes);

  /** Color que manda ahora mismo: el que se está capturando, o el guardado. */
  const hexEnEdicion = (c: Client) => colores[c.id] ?? c.branding?.primaryColor ?? "";

  const setColor = (clientId: string, valor: string) =>
    setColores((prev) => ({ ...prev, [clientId]: valor }));

  /** Guarda el hex capturado, si de verdad cambió respecto a lo que ya estaba. */
  const guardarColor = (c: Client, valor: string) => {
    const v = normalizaHex(valor);
    if (v === (c.branding?.primaryColor ?? "")) return;
    guardar(`color-${c.id}`, c.id, { primaryColor: v });
  };

  // --- Campos de texto ------------------------------------------------------

  /**
   * Nombre del producto y frase. Los dos son "vacío = hereda el proveedor", así
   * que el placeholder muestra lo que se usaría en ese caso.
   */
  const campoTexto = (
    c: Client,
    campo: "appName" | "tagline",
    label: string,
    max: number,
    placeholder: string,
    ayuda: string,
  ) => {
    const key = `${campo}-${c.id}`;
    const actual = c.branding?.[campo] ?? "";
    return (
      <label className="block">
        <span className="text-[11px] font-medium text-muted-foreground">
          {label} <span className="font-normal">(máx. {max})</span>
        </span>
        <div className="mt-1 flex items-center gap-2">
          <input
            // Rehacer el input cuando cambia el valor guardado lo resincroniza
            // tras el guardado (y tras un fallo lo deja como quedó en Firestore).
            key={`${key}-${actual}`}
            type="text"
            maxLength={max}
            spellCheck={false}
            autoCorrect="off"
            className="h-9 w-full rounded-md border bg-background px-2 text-xs"
            placeholder={placeholder}
            title={ayuda}
            defaultValue={actual}
            disabled={busy === key}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === actual) return;
              guardar(key, c.id, { [campo]: v });
            }}
          />
          {busy === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <span className="mt-1 block text-[11px] text-muted-foreground">{ayuda}</span>
      </label>
    );
  };

  // --- Campos de imagen -----------------------------------------------------

  const campoImagen = (c: Client, campo: CampoImagen) => {
    const key = `${campo}-${c.id}`;
    const meta = IMAGENES[campo];
    const actual = c.branding?.[campo] ?? "";
    const ocupado = busy === key;
    const embebida = actual.startsWith("data:");

    return (
      <div>
        <span className="text-[11px] font-medium text-muted-foreground">{meta.label}</span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            key={`${key}-${actual.slice(0, 64)}`}
            type="url"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
            placeholder="https://vectis.mx/logo.svg"
            title={`${meta.ayuda} Pega una URL https:// o carga el archivo.`}
            defaultValue={embebida ? "" : actual}
            disabled={ocupado}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              // Con imagen embebida el campo se muestra vacío (un data URI no
              // cabe legible): vacío ahí no significa "quítala", eso es el botón.
              if (v === (embebida ? "" : actual)) return;
              guardar(key, c.id, { [campo]: v });
            }}
          />

          {/* El archivo se lee en el navegador y se guarda como data URI: no hay
              bucket, así que la imagen viaja dentro del doc del cliente. */}
          <label
            className={cn(
              "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent",
              ocupado && "pointer-events-none opacity-50",
            )}
            title="Carga un PNG, JPG, WebP o SVG desde tu computadora."
          >
            <Upload className="h-3.5 w-3.5" /> Cargar archivo
            <input
              type="file"
              accept={TIPOS_IMAGEN}
              className="hidden"
              disabled={ocupado}
              onChange={(e) => {
                const archivo = e.target.files?.[0];
                // Se limpia el input para que volver a elegir el MISMO archivo
                // (tras corregirlo) dispare el change otra vez.
                e.target.value = "";
                if (!archivo) return;
                if (archivo.size > MAX_ARCHIVO_BYTES) {
                  setError(
                    `«${archivo.name}» pesa ${kb(archivo.size)} y el tope para embeber es ${kb(MAX_ARCHIVO_BYTES)}. Comprímelo, o súbelo a un hosting y pega aquí su URL.`,
                  );
                  return;
                }
                void run(
                  key,
                  async () => {
                    const uri = await leerDataUri(archivo);
                    await setClientBranding(c.id, { [campo]: uri });
                  },
                  refrescarClientes,
                );
              }}
            />
          </label>

          {ocupado && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        {/* Vista previa de lo que hay guardado, con su botón de quitar */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actual ? (
            <>
              <img
                src={actual}
                alt={`${meta.label} de ${clientDisplayName(c)}`}
                className="max-h-10 max-w-[160px] object-contain"
              />
              {embebida && (
                <Badge variant="secondary" title="La imagen vive dentro del documento del cliente.">
                  embebida · {kb(actual.length)}
                </Badge>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={ocupado}
                title={`Quitar el ${meta.label.toLowerCase()} de esta empresa.`}
                onClick={() => guardar(key, c.id, { [campo]: "" })}
              >
                <Trash2 className="h-4 w-4" /> Quitar
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ImageOff className="h-3.5 w-3.5" /> {meta.vacio}
            </span>
          )}
        </div>
      </div>
    );
  };

  // --- Color ----------------------------------------------------------------

  const campoColor = (c: Client) => {
    const key = `color-${c.id}`;
    const guardado = c.branding?.primaryColor ?? "";
    const enEdicion = hexEnEdicion(c);
    const pendiente = normalizaHex(enEdicion) !== guardado;
    return (
      <div>
        <span className="text-[11px] font-medium text-muted-foreground">Color de marca</span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            type="color"
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1"
            value={hexParaPicker(enEdicion)}
            disabled={busy === key}
            title="Elige el color y sal del campo para guardarlo."
            onChange={(e) => setColor(c.id, e.target.value)}
            onBlur={(e) => guardarColor(c, e.target.value)}
          />
          <input
            type="text"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            maxLength={7}
            className="h-9 w-28 rounded-md border bg-background px-2 font-mono text-xs"
            placeholder={COLOR_DEFAULT}
            title="En hex, por ejemplo #0ea5e9. Vacío = el color por defecto."
            value={enEdicion}
            disabled={busy === key}
            onChange={(e) => setColor(c.id, e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => guardarColor(c, e.target.value)}
          />
          {busy === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {guardado && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy === key}
              title="Vuelve al azul del tema para esta empresa."
              onClick={() => {
                setColor(c.id, "");
                guardar(key, c.id, { primaryColor: "" });
              }}
            >
              <RotateCcw className="h-4 w-4" /> Color por defecto
            </Button>
          )}
        </div>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          Pisa el primario de toda la interfaz: botones, links y focos.{" "}
          {pendiente
            ? "Sin guardar todavía — sal del campo para guardarlo."
            : "Se guarda al salir del campo."}
        </span>
      </div>
    );
  };

  // --- Vista previa ---------------------------------------------------------

  /**
   * Simulación de la barra superior con la marca de esa empresa.
   *
   * El color se mete como propiedades en línea en ESTE contenedor: todo lo de
   * adentro (`bg-primary`, `text-primary`, el botón de shadcn) hereda las
   * variables de aquí en vez de las del `:root`, así que la vista previa se tiñe
   * sin tocar el tema global ni el resto del dashboard.
   */
  const vistaPrevia = (c: Client) => {
    const b = c.branding ?? {};
    const nombre = b.appName?.trim() || VENDOR_BRANDING.appName;
    const hex = normalizaHex(hexEnEdicion(c));
    const triplete = hex ? brandTriplet(hex) : null;
    const estilo = triplete
      ? ({
          "--primary": triplete,
          "--ring": triplete,
          "--primary-foreground": foregroundForHex(hex),
        } as React.CSSProperties)
      : undefined;

    return (
      <div className="mt-3 border-t pt-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold">
          <Eye className="h-3.5 w-3.5 text-primary" /> Vista previa
        </h4>
        <div style={estilo} className="mt-2 rounded-lg border bg-background p-3">
          <div className="flex flex-wrap items-center gap-3">
            {b.logoUrl ? (
              <img src={b.logoUrl} alt="" className="max-h-10 max-w-[140px] object-contain" />
            ) : (
              // Sin logo, la barra real muestra solo el nombre: aquí se sugiere
              // con un cuadro del color de marca para que el color se vea igual.
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
                {nombre.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{nombre}</div>
              {b.tagline?.trim() && (
                <div className="truncate text-[11px] text-muted-foreground">{b.tagline.trim()}</div>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Muestras: no hacen nada, están para ver el color de marca
                  aplicado a un badge y a un botón reales. */}
              <span className="text-[10px] text-muted-foreground">así se verán:</span>
              <Badge>Ejemplo</Badge>
              <Button size="sm">Botón</Button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {b.hideVendorBrand ? (
              "Sin firma en el pie."
            ) : (
              <>{VENDOR_SIGNATURE}</>
            )}
          </p>
        </div>
      </div>
    );
  };

  // --- Marca por dominio (root) ---------------------------------------------

  const publicarDominio = () => {
    if (!appUser) return;
    const c = visibleClients.find((x) => x.id === dominioClientId);
    if (!c) {
      setError("Elige la empresa cuya marca se va a publicar en ese dominio.");
      return;
    }
    const b = c.branding ?? {};
    // Se arma llave por llave: Firestore rechaza `undefined`, y de la marca
    // completa aquí solo puede ir lo que no es privado — nombre, logo, color y
    // frase. El favicon y `hideVendorBrand` se resuelven ya con sesión.
    const payload: PublicBranding = {
      appName: b.appName?.trim() || VENDOR_BRANDING.appName,
      clientId: c.id,
    };
    if (b.logoUrl) payload.logoUrl = b.logoUrl;
    if (b.primaryColor) payload.primaryColor = b.primaryColor;
    if (b.tagline?.trim()) payload.tagline = b.tagline.trim();

    void run("publicar", () => setPublicBranding(dominio, payload, appUser.email), refrescarPublica);
  };

  const quitarDominio = () => {
    if (!appUser) return;
    const ok = window.confirm(
      `¿Quitar la marca publicada de ${dominio.trim().toLowerCase()}? El login de ese dominio vuelve a mostrar la marca de ${VENDOR_BRANDING.appName}.`,
    );
    if (!ok) return;
    void run("despublicar", () => setPublicBranding(dominio, null, appUser.email), refrescarPublica);
  };

  return (
    <div className="space-y-4">
      {/* --- De qué va esta pantalla -------------------------------------- */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Cada empresa puede ver la herramienta con su propia marca: su nombre, su logo y su color, como
        si el producto fuera suyo. Lo que se deje vacío usa la marca del proveedor
        (<span className="font-medium text-foreground">{VENDOR_BRANDING.appName}</span>). Nada de esto
        es secreto: la marca vive en el documento de la empresa y la lee cualquiera que pertenezca a
        ella, que es justo quien necesita ver su logo en la barra.
      </p>

      {isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> cargando la marca de las empresas…
        </p>
      )}

      {/* --- Una card por empresa ------------------------------------------ */}
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="h-4 w-4 text-primary" /> Por empresa ({visibleClients.length})
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Los cambios se guardan al salir de cada campo. La marca se aplica a todos los usuarios de esa
          empresa la próxima vez que carguen el dashboard.
        </p>
      </div>

      {!isLoading && visibleClients.length === 0 && (
        <p className="text-xs text-muted-foreground">No hay empresas cuya marca puedas configurar.</p>
      )}

      <div className="space-y-3">
        {visibleClients.map((c) => {
          const b = c.branding ?? {};
          const oculta = !!b.hideVendorBrand;
          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                  <span className="text-sm font-semibold">{clientDisplayName(c)}</span>
                  {b.appName?.trim() || b.logoUrl || b.primaryColor ? (
                    <Badge variant="success">Marca propia</Badge>
                  ) : (
                    <Badge variant="secondary">Usa la marca del proveedor</Badge>
                  )}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {campoTexto(
                    c,
                    "appName",
                    "Nombre del producto",
                    40,
                    VENDOR_BRANDING.appName,
                    "Cómo se llama la herramienta para esta empresa. Vacío = el nombre del proveedor.",
                  )}
                  {campoTexto(
                    c,
                    "tagline",
                    "Frase",
                    90,
                    VENDOR_BRANDING.tagline ?? "",
                    "Se muestra bajo el nombre en la pantalla de acceso.",
                  )}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {campoImagen(c, "logoUrl")}
                  {campoImagen(c, "faviconUrl")}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Un archivo cargado aquí se guarda dentro del documento de la empresa, y al codificarlo
                  crece cerca de un tercio: el tope real son {kb(MAX_ARCHIVO_BYTES)} ya codificado. Para
                  imágenes grandes, súbelas a un hosting y pega la URL.
                </p>

                <div className="mt-3">{campoColor(c)}</div>

                {/* Firma del proveedor: un pill, como los interruptores del resto */}
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={busy === `firma-${c.id}`}
                    title={
                      oculta
                        ? "El pie no menciona al proveedor — click para volver a mostrarlo"
                        : "El pie menciona al proveedor — click para ocultarlo"
                    }
                    onClick={() => guardar(`firma-${c.id}`, c.id, { hideVendorBrand: !oculta })}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                      oculta
                        ? "border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {busy === `firma-${c.id}`
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Palette className="h-3 w-3" />}
                    Ocultar la firma del proveedor
                  </button>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Prendido = el pie no muestra «{VENDOR_SIGNATURE}». Para el cliente la
                    herramienta se ve completamente suya.
                  </p>
                </div>

                {vistaPrevia(c)}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* --- Marca por dominio: solo el root ------------------------------- */}
      {esRoot && (
        <Card>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Globe className="h-4 w-4 text-primary" /> Marca por dominio
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              La pantalla de acceso no sabe quién está entrando: todavía no hay sesión, así que no hay
              empresa de la que sacar la marca. Por eso ahí se resuelve por el dominio.
              <br />
              Esto es lo que hace que un cliente con su propio dominio vea su marca desde la puerta, y
              no la del proveedor hasta después de entrar.
            </p>

            {/* Qué hay publicado para el dominio por el que entramos ahora */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Dominio actual:</span>
              <code className="rounded bg-muted px-1 font-mono">{hostActual || "sin dominio"}</code>
              {cargandoPublica ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : publicada ? (
                <Badge variant="success">
                  Publicado como «{publicada.appName}»
                  {publicada.primaryColor ? ` · ${publicada.primaryColor}` : ""}
                </Badge>
              ) : (
                <Badge variant="secondary">Sin marca publicada — el login usa la del proveedor</Badge>
              )}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11px] font-medium text-muted-foreground">Dominio</span>
                <input
                  type="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
                  placeholder="tracker.vectis.mx"
                  title="Solo el host, sin https:// ni rutas."
                  value={dominio}
                  disabled={busy === "publicar" || busy === "despublicar"}
                  onChange={(e) => setDominio(e.target.value)}
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Solo el host: sin <code className="rounded bg-muted px-1 font-mono">https://</code> ni
                  rutas.
                </span>
              </label>

              <label className="block">
                <span className="text-[11px] font-medium text-muted-foreground">Empresa</span>
                <SelectNative
                  className="mt-1 w-full"
                  value={dominioClientId}
                  disabled={busy === "publicar" || busy === "despublicar"}
                  onChange={(e) => setDominioClientId(e.target.value)}
                >
                  <option value="">— elige la empresa —</option>
                  {visibleClients.map((c) => (
                    <option key={c.id} value={c.id}>{clientDisplayName(c)}</option>
                  ))}
                </SelectNative>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Se publica la marca que esa empresa tiene arriba: nombre, logo, color y frase.
                </span>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!dominio.trim() || !dominioClientId || busy === "publicar"}
                onClick={publicarDominio}
              >
                {busy === "publicar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Publicar
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!dominio.trim() || busy === "despublicar"}
                title="Borra el documento de ese dominio: su login vuelve a la marca del proveedor."
                onClick={quitarDominio}
              >
                {busy === "despublicar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Quitar la publicación
              </Button>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              Cuidado: <code className="rounded bg-muted px-1 font-mono">public_branding/{"{dominio}"}</code> es
              de <span className="font-semibold">lectura pública</span> — lo lee cualquiera sin sesión,
              porque el login tiene que pintarse antes de que haya usuario. Ahí solo va nombre, logo,
              color y frase. Nada de datos de la empresa, contactos ni nada que no quieras que se vea
              desde fuera.
            </p>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
