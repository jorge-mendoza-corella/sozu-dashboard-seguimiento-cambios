import {
  Settings, Building2, FolderTree, Receipt, Coins, MessageSquare, Palette,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { isRootAdmin } from "@/lib/firestoreUsers";
import { ClientsSection } from "@/components/config/ClientsSection";
import { ProjectAssignmentSection } from "@/components/config/ProjectAssignmentSection";
import { PricingFeaturesSection } from "@/components/config/PricingFeaturesSection";
import { FacturapiSection } from "@/components/config/FacturapiSection";
import { NotificationsSection } from "@/components/config/NotificationsSection";
import { BrandingSection } from "@/components/config/BrandingSection";
import { useClientScope } from "@/hooks/useClients";

/**
 * `soloGlobal` marca lo que es del dueño del SaaS: dar de alta clientes, mover
 * tarifas y facturar. Un administrador de empresa entra a esta pantalla, pero
 * solo a lo suyo: los avisos de sus empresas y la marca con la que las ve.
 */
const TABS = [
  { value: "clientes", label: "Clientes", icon: Building2, soloGlobal: true },
  { value: "estructura", label: "Proyectos y repos", icon: FolderTree, soloGlobal: true },
  { value: "precios", label: "Precios y features", icon: Coins, soloGlobal: true },
  // La marca va primero: es lo que el cliente ve, y lo primero que quiere dejar
  // puesto. Los avisos vienen después.
  { value: "marca", label: "Marca", icon: Palette, soloGlobal: false },
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
  const isRoot = isRootAdmin(appUser);
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
      <Tabs defaultValue={tabs[0]?.value ?? "marca"}>
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
        <TabsContent value="marca">
          <BrandingSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
