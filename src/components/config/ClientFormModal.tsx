import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Loader2, Save, Building2, ReceiptText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { useClientsBilling } from "@/hooks/useClients";
import { useAuth } from "@/hooks/useAuth";
import {
  addClient, updateClient, setClientFiscal,
  REGIMENES_FISCALES, USOS_CFDI, clientDisplayName,
} from "@/lib/firestoreClients";
import type { Client, FiscalData, PersonaType, ClientStatus } from "@/lib/firestoreClients";

/**
 * Todo el formulario vive en un solo objeto de strings: los inputs quedan
 * controlados sin refs y el armado del payload para Firestore es un único
 * lugar (`buildFiscal`), no veinte `if` repartidos por el JSX.
 */
interface FormState {
  // Datos generales
  legalName: string;
  tradeName: string;
  personaType: PersonaType;
  status: ClientStatus;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  // Datos fiscales
  taxId: string;
  taxSystem: string;
  usoCfdi: string;
  billingEmail: string;
  zip: string;
  street: string;
  exterior: string;
  interior: string;
  neighborhood: string;
  city: string;
  municipality: string;
  state: string;
  country: string;
}

const emptyForm = (): FormState => ({
  legalName: "", tradeName: "", personaType: "moral", status: "activo",
  contactName: "", contactEmail: "", contactPhone: "", notes: "",
  taxId: "", taxSystem: "", usoCfdi: "", billingEmail: "",
  zip: "", street: "", exterior: "", interior: "", neighborhood: "",
  city: "", municipality: "", state: "", country: "MEX",
});

const formFromClient = (c: Client): FormState => ({
  legalName: c.legalName,
  tradeName: c.tradeName ?? "",
  personaType: c.personaType ?? "moral",
  status: c.status ?? "activo",
  contactName: c.contactName ?? "",
  contactEmail: c.contactEmail ?? "",
  contactPhone: c.contactPhone ?? "",
  notes: c.notes ?? "",
  taxId: c.fiscal?.taxId ?? "",
  taxSystem: c.fiscal?.taxSystem ?? "",
  usoCfdi: c.fiscal?.usoCfdi ?? "",
  billingEmail: c.fiscal?.billingEmail ?? "",
  zip: c.fiscal?.zip ?? "",
  street: c.fiscal?.street ?? "",
  exterior: c.fiscal?.exterior ?? "",
  interior: c.fiscal?.interior ?? "",
  neighborhood: c.fiscal?.neighborhood ?? "",
  city: c.fiscal?.city ?? "",
  municipality: c.fiscal?.municipality ?? "",
  state: c.fiscal?.state ?? "",
  country: c.fiscal?.country ?? "MEX",
});

/**
 * Se mandan también los campos vacíos: `setClientFiscal` hace merge, así que
 * omitir una llave dejaría el valor viejo y sería imposible borrar un dato
 * fiscal desde la UI.
 */
const buildFiscal = (f: FormState): FiscalData => ({
  taxId: f.taxId, taxSystem: f.taxSystem, usoCfdi: f.usoCfdi, billingEmail: f.billingEmail,
  zip: f.zip, street: f.street, exterior: f.exterior, interior: f.interior,
  neighborhood: f.neighborhood, city: f.city, municipality: f.municipality,
  state: f.state, country: f.country,
});

/** El país trae default "MEX", por eso no cuenta para decidir si hay datos fiscales. */
const tieneAlgoFiscal = (f: FormState): boolean =>
  [f.taxId, f.taxSystem, f.usoCfdi, f.billingEmail, f.zip, f.street, f.exterior,
    f.interior, f.neighborhood, f.city, f.municipality, f.state]
    .some((v) => v.trim() !== "");

const STATUS_LABEL: Record<ClientStatus, string> = {
  activo: "Activo",
  suspendido: "Suspendido",
  prospecto: "Prospecto",
};

export function ClientFormModal({ clientId, onClose }: { clientId: string | null; onClose: () => void }) {
  const { appUser } = useAuth();
  // El formulario de edición se siembra con los datos fiscales, que viven en el
  // doc privado del cliente: hay que leerlos con la query de billing.
  const { data: clients = [], isLoading } = useClientsBilling(appUser);
  const client = clientId ? clients.find((c) => c.id === clientId) : undefined;

  // Al editar hay que esperar el cliente antes de sembrar el estado local: si
  // se monta el formulario con la lista aún vacía, los inputs nacen vacíos y
  // guardar borraría los datos existentes.
  if (clientId && !client) {
    return (
      <Shell onClose={onClose} title="Editar cliente">
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          {isLoading
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Cargando cliente…</>
            : <>No se encontró el cliente.</>}
        </div>
      </Shell>
    );
  }

  return <Form key={clientId ?? "nuevo"} client={client ?? null} onClose={onClose} />;
}

/** Overlay + card: mismo patrón que ManageModal (click fuera cierra). */
function Shell({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Building2 className="h-5 w-5 text-primary" /> {title}
            </h2>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "h-9 w-full rounded-md border bg-background px-2.5 text-sm";

function Form({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { appUser } = useAuth();
  const [form, setForm] = useState<FormState>(() => (client ? formFromClient(client) : emptyForm()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const regimenes = REGIMENES_FISCALES.filter((r) => r.persona.includes(form.personaType));

  /** El régimen depende del tipo de persona: al cambiarlo se suelta uno incompatible. */
  const setPersona = (personaType: PersonaType) =>
    setForm((prev) => ({
      ...prev,
      personaType,
      taxSystem: REGIMENES_FISCALES.some((r) => r.code === prev.taxSystem && r.persona.includes(personaType))
        ? prev.taxSystem
        : "",
    }));

  const guardar = async () => {
    setBusy(true);
    setError("");
    try {
      if (!appUser) throw new Error("No hay sesión activa para registrar al cliente.");
      const fiscal = buildFiscal(form);
      if (client) {
        await updateClient(client.id, {
          legalName: form.legalName,
          tradeName: form.tradeName,
          personaType: form.personaType,
          status: form.status,
          contactName: form.contactName,
          contactEmail: form.contactEmail,
          contactPhone: form.contactPhone,
          notes: form.notes,
        });
        // En edición siempre se manda el bloque fiscal: es la única forma de
        // vaciar un campo que ya estaba guardado.
        await setClientFiscal(client.id, fiscal);
      } else {
        const nuevoId = await addClient({
          legalName: form.legalName,
          tradeName: form.tradeName,
          personaType: form.personaType,
          status: form.status,
          contactName: form.contactName,
          contactEmail: form.contactEmail,
          contactPhone: form.contactPhone,
        }, appUser.email);
        // Al crear, el bloque fiscal solo se escribe si el usuario capturó algo.
        if (tieneAlgoFiscal(form)) await setClientFiscal(nuevoId, fiscal);
      }
      await qc.invalidateQueries({ queryKey: ["clients"] });
      onClose();
    } catch (e) {
      // Los mensajes de validación (RFC, CP, razón social) vienen de la capa de
      // datos y son los que el usuario necesita leer: no se tragan.
      setError(e instanceof Error ? e.message : "No se pudo guardar el cliente.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell onClose={onClose} title={client ? `Editar ${clientDisplayName(client)}` : "Nuevo cliente"}>
      {/* Datos generales */}
      <h3 className="text-sm font-semibold text-muted-foreground">Datos generales</h3>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Razón social o nombre completo *">
            <input
              autoFocus
              className={inputCls}
              placeholder="Comercializadora Ejemplo S.A. de C.V."
              value={form.legalName}
              onChange={(e) => set("legalName", e.target.value)}
            />
          </Field>
        </div>
        <Field label="Nombre comercial">
          <input
            className={inputCls}
            placeholder="Cómo se le conoce"
            value={form.tradeName}
            onChange={(e) => set("tradeName", e.target.value)}
          />
        </Field>
        <Field label="Tipo de persona">
          <SelectNative
            className="h-9"
            value={form.personaType}
            onChange={(e) => setPersona(e.target.value as PersonaType)}
          >
            <option value="moral">Persona moral (empresa)</option>
            <option value="fisica">Persona física</option>
          </SelectNative>
        </Field>
        <Field label="Estatus">
          <SelectNative
            className="h-9"
            value={form.status}
            onChange={(e) => set("status", e.target.value as ClientStatus)}
          >
            {(Object.keys(STATUS_LABEL) as ClientStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </SelectNative>
        </Field>
        <Field label="Contacto">
          <input
            className={inputCls}
            placeholder="Nombre de quien atiende"
            value={form.contactName}
            onChange={(e) => set("contactName", e.target.value)}
          />
        </Field>
        <Field label="Email de contacto">
          <input
            type="email"
            className={inputCls}
            placeholder="contacto@empresa.com"
            value={form.contactEmail}
            onChange={(e) => set("contactEmail", e.target.value)}
          />
        </Field>
        <Field label="Teléfono">
          <input
            className={inputCls}
            placeholder="55 1234 5678"
            value={form.contactPhone}
            onChange={(e) => set("contactPhone", e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notas">
            <textarea
              className="min-h-20 w-full rounded-md border bg-background px-2.5 py-2 text-sm"
              placeholder="Acuerdos, condiciones especiales, historia del cliente…"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Datos fiscales */}
      <h3 className="mt-6 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <ReceiptText className="h-4 w-4" /> Datos fiscales (para facturar)
      </h3>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Opcional por ahora — se necesita RFC, régimen y CP para timbrar en Facturapi.
      </p>
      {/* Todo este bloque va con `autoComplete="off"`: son datos del CLIENTE y el
          autocompletado del navegador rellenaría los del operador (su propio
          email o domicilio), que acabarían timbrados en el CFDI ajeno. */}
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="RFC">
          <input
            className={`${inputCls} uppercase`}
            placeholder="XAXX010101000"
            spellCheck={false}
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            value={form.taxId}
            onChange={(e) => set("taxId", e.target.value)}
          />
        </Field>
        <Field label="Régimen fiscal">
          <SelectNative
            className="h-9"
            value={form.taxSystem}
            onChange={(e) => set("taxSystem", e.target.value)}
          >
            <option value="">— sin definir —</option>
            {regimenes.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </SelectNative>
        </Field>
        <Field label="Uso del CFDI">
          <SelectNative
            className="h-9"
            value={form.usoCfdi}
            onChange={(e) => set("usoCfdi", e.target.value)}
          >
            <option value="">— sin definir —</option>
            {USOS_CFDI.map((u) => (
              <option key={u.code} value={u.code}>{u.label}</option>
            ))}
          </SelectNative>
        </Field>
        <Field label="Email de facturación">
          <input
            type="email"
            className={inputCls}
            placeholder="facturas@empresa.com"
            autoComplete="off"
            value={form.billingEmail}
            onChange={(e) => set("billingEmail", e.target.value)}
          />
        </Field>
        <Field label="Código postal">
          <input
            className={inputCls}
            inputMode="numeric"
            maxLength={5}
            placeholder="06600"
            autoComplete="off"
            value={form.zip}
            onChange={(e) => set("zip", e.target.value)}
          />
        </Field>
        <Field label="Calle">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.street}
            onChange={(e) => set("street", e.target.value)}
          />
        </Field>
        <Field label="Número exterior">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.exterior}
            onChange={(e) => set("exterior", e.target.value)}
          />
        </Field>
        <Field label="Número interior">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.interior}
            onChange={(e) => set("interior", e.target.value)}
          />
        </Field>
        <Field label="Colonia">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.neighborhood}
            onChange={(e) => set("neighborhood", e.target.value)}
          />
        </Field>
        <Field label="Ciudad">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
          />
        </Field>
        <Field label="Municipio o alcaldía">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.municipality}
            onChange={(e) => set("municipality", e.target.value)}
          />
        </Field>
        <Field label="Estado">
          <input
            className={inputCls}
            autoComplete="off"
            value={form.state}
            onChange={(e) => set("state", e.target.value)}
          />
        </Field>
        <Field label="País (código de 3 letras)">
          <input
            className={`${inputCls} uppercase`}
            placeholder="MEX"
            maxLength={3}
            spellCheck={false}
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            value={form.country}
            onChange={(e) => set("country", e.target.value)}
          />
        </Field>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button size="sm" onClick={guardar} disabled={busy || !form.legalName.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {client ? "Guardar cambios" : "Crear cliente"}
        </Button>
      </div>
    </Shell>
  );
}
