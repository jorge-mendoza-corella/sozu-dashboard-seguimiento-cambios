import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Settings, Building2, FolderTree, Receipt, Coins, Sparkles, Loader2, MessageSquare,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { seedSaasStructure, type SeedReport } from "@/lib/saasSeed";
import { ClientsSection } from "@/components/config/ClientsSection";
import { ProjectAssignmentSection } from "@/components/config/ProjectAssignmentSection";
import { PricingFeaturesSection } from "@/components/config/PricingFeaturesSection";
import { FacturapiSection } from "@/components/config/FacturapiSection";
import { NotificationsSection } from "@/components/config/NotificationsSection";
import { useClientScope } from "@/hooks/useClients";

/**
 * `soloGlobal` marca lo que es del dueño del SaaS: dar de alta clientes, mover
 * tarifas y facturar. Un administrador de empresa entra a esta pantalla, pero
 * solo a lo suyo — hoy, las notificaciones de sus empresas.
 */
const TABS = [
  { value: "clientes", label: "Clientes", icon: Building2, soloGlobal: true },
  { value: "estructura", label: "Proyectos y repos", icon: FolderTree, soloGlobal: true },
  { value: "precios", label: "Precios y features", icon: Coins, soloGlobal: true },
  { value: "notificaciones", label: "Notificaciones", icon: MessageSquare, soloGlobal: false },
  { value: "facturacion", label: "Facturación", icon: Receipt, soloGlobal: true },
] as const;

/**
 * Centro de configuración del SaaS. Todo lo administrativo vive aquí: los
 * clientes que pagan, cómo se reparten sus proyectos y repos, cuánto cuesta
 * cada cosa y con qué llave se factura.
 */
export function ConfiguracionPage() {
  const { appUser } = useAuth();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const { esAdminGlobal } = useClientScope(appUser);
  // Las pestañas "globales" escriben clientes, tarifas y la llave de Facturapi,
  // y esas escrituras las reglas se las reservan al root. Mostrárselas a un
  // superuser no-root solo le daría un permission-denied en cada campo.
  const tabs = TABS.filter((t) => isRoot || !t.soloGlobal);

  return (
    <div className="p-6">
      <div className="mb-5">
        <div className="mb-1 flex items-center gap-2">
          <Settings className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Configuración</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {esAdminGlobal
            ? "Clientes, estructura de proyectos, tarifas y facturación del servicio."
            : "Configuración de las empresas que administras."}
        </p>
      </div>

      {/* No hay banner de "modo lectura": la ruta ya es exclusiva del root
          (App.tsx redirige al resto), y prometer lectura con todos los botones
          activos era peor que no prometer nada. Si algún día se abre a los
          Administradores, hay que deshabilitar los controles de verdad. */}
      <Tabs defaultValue={tabs[0]?.value ?? "notificaciones"}>
        <TabsList className="flex-wrap">
          {tabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {isRoot && (
          <>
            <TabsContent value="clientes">
              <ClientsSection />
              <SeedSection />
            </TabsContent>
            <TabsContent value="estructura">
              <ProjectAssignmentSection />
            </TabsContent>
            <TabsContent value="precios">
              <PricingFeaturesSection />
            </TabsContent>
            <TabsContent value="facturacion">
              <FacturapiSection />
            </TabsContent>
          </>
        )}
        <TabsContent value="notificaciones">
          <NotificationsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Siembra la estructura con la que arranca la operación (Vectis, Sozu, Monocolo
 * y Mutuo, más los proyectos de Sozu). Es idempotente, así que el botón se puede
 * apretar de nuevo sin duplicar nada: solo completa lo que falte.
 */
function SeedSection() {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<SeedReport | null>(null);

  const sembrar = async () => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const r = await seedSaasStructure(appUser!.email);
      setReport(r);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["clients"] }),
        qc.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo sembrar la estructura inicial");
    } finally {
      setBusy(false);
    }
  };

  const nada =
    report &&
    report.clientesCreados.length === 0 &&
    report.proyectosCreados.length === 0 &&
    report.proyectosRenombrados.length === 0 &&
    report.proyectosAsignados.length === 0 &&
    !report.notificacionesSembradas;

  return (
    <Card className="mt-6">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-violet-500" /> Estructura inicial
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Crea los clientes Vectis, Sozu, Monocolo y Mutuo, renombra el proyecto histórico
              SOZU a «Admin» y da de alta Landings, Sozu Clientes APP y Sozu Agentes APP bajo
              el cliente Sozu. Se puede correr varias veces: solo agrega lo que falte.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={sembrar}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
            {busy ? "Sembrando…" : "Sembrar"}
          </Button>
        </div>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        {report && (
          <div className="mt-3 space-y-1 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            {nada ? (
              <p>Ya estaba todo: no hubo nada que crear.</p>
            ) : (
              <>
                {report.clientesCreados.length > 0 && (
                  <p>Clientes creados: {report.clientesCreados.join(", ")}</p>
                )}
                {report.proyectosCreados.length > 0 && (
                  <p>Proyectos creados: {report.proyectosCreados.join(", ")}</p>
                )}
                {report.proyectosRenombrados.length > 0 && (
                  <p>Renombrados: {report.proyectosRenombrados.join(" · ")}</p>
                )}
                {report.proyectosAsignados.length > 0 && (
                  <p>Asignados al cliente Sozu: {report.proyectosAsignados.join(", ")}</p>
                )}
                {report.notificacionesSembradas && (
                  <p>
                    Notificaciones: se cargó la instancia, el webhook y el teléfono admin que
                    traía el CI. Falta pegar la apikey en la pestaña Notificaciones.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
