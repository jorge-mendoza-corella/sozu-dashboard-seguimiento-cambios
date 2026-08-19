import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Activity, GitBranch, Users, GitCommit, LogOut, LayoutDashboard, HardHat, ExternalLink,
  TrendingUp, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useBranding, useApplyBranding } from "@/hooks/useBranding";
import { VENDOR_BRANDING } from "@/lib/branding";
import { useAvancesAccess, AVANCES_URL_DEFAULT } from "@/hooks/useClients";
import { SUPERUSER_EMAIL, canAdminister } from "@/lib/firestoreUsers";
import { Button } from "@/components/ui/button";
import { AvancesDraftBadge } from "@/components/AvancesDraftBadge";
import { BuildNotifier } from "@/components/codemagic/BuildNotifier";

// Cada item dice quién lo ve: el root, cualquier administrador (global o de
// empresa), o todo el mundo. Las rutas repiten el corte en App.tsx.
interface NavVisibility { root: boolean; admin: boolean; adminGlobal: boolean }

const NAV_ITEMS = [
  { to: "/resumen", label: "Resumen", icon: LayoutDashboard, show: () => true },
  { to: "/", label: "CI/CD", icon: GitBranch, show: () => true },
  // Negocio son las tarifas y los datos fiscales de la cartera: solo admin
  // global. Un administrador de empresa no ve ni lo suyo aquí — las reglas ni
  // siquiera le dejan leer su `private/billing`.
  { to: "/negocio", label: "Negocio", icon: TrendingUp, show: (v: NavVisibility) => v.adminGlobal },
  { to: "/contributors", label: "Contribuidores", icon: GitCommit, show: (v: NavVisibility) => v.root },
  { to: "/users", label: "Usuarios", icon: Users, show: (v: NavVisibility) => v.admin },
  { to: "/configuracion", label: "Configuración", icon: Settings, show: (v: NavVisibility) => v.admin },
];

interface Props { children: React.ReactNode }

export function AppLayout({ children }: Props) {
  const { appUser, logout } = useAuth();
  const { pathname } = useLocation();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const navItems = NAV_ITEMS.filter((i) =>
    i.show({
      root: isRoot,
      admin: canAdminister(appUser),
      adminGlobal: isRoot || appUser?.role === "superuser",
    }),
  );
  // Marca de la empresa del usuario (o la del proveedor): tiñe la interfaz,
  // el título de la pestaña y el favicon.
  const branding = useBranding(appUser);
  useApplyBranding(branding);
  const [logoRoto, setLogoRoto] = useState(false);
  // La firma del proveedor solo aparece cuando la marca es de una empresa y esa
  // empresa no pidió esconderla.
  const muestraFirmaProveedor = branding.clientId !== null && !branding.hideVendorBrand;
  // Ver avances es una feature que se contrata por cliente: si ninguno de los
  // clientes del usuario la tiene prendida, el link no aparece.
  const avances = useAvancesAccess(appUser);
  // La URL viene de Firestore y termina en un href: se revalida el esquema aquí
  // también, no solo al guardarla, para que un `javascript:` escrito por fuera
  // del dashboard no se convierta en un link ejecutable.
  const avancesUrl = /^https?:\/\//i.test(avances.url) ? avances.url : AVANCES_URL_DEFAULT;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top nav */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-4 px-6">
          <Link to="/" className="flex items-center gap-2 font-bold text-primary no-underline">
            {branding.logoUrl && !logoRoto ? (
              <img
                src={branding.logoUrl}
                alt={branding.appName}
                className="h-6 max-w-[140px] object-contain"
                // Un logo cuya URL ya no existe dejaría la barra sin identidad:
                // si la imagen falla se vuelve al icono de siempre.
                onError={() => setLogoRoto(true)}
              />
            ) : (
              <Activity className="h-5 w-5" />
            )}
            {branding.appName}
          </Link>
          <nav className="flex items-center gap-1 ml-2">
            {navItems.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors no-underline",
                  pathname === to
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
            {/* Sitio de avance de obra (aplicación aparte, se abre en otra pestaña).
                Para el root incluye el badge del borrador pendiente. */}
            {isRoot ? (
              <AvancesDraftBadge email={appUser?.email ?? ""} />
            ) : avances.allowed ? (
              <a
                href={avancesUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
                title={`Avance de obra — ${avancesUrl.replace(/^https?:\/\//, "")}`}
              >
                <HardHat className="h-4 w-4" />
                Avances
                <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span
              className="hidden font-mono text-[10px] text-muted-foreground/60 md:block"
              title="Versión desplegada (se genera en cada deploy)"
            >
              v{__APP_BUILD__}
            </span>
            <span className="text-xs text-muted-foreground hidden sm:block">{appUser?.email}</span>
            <Button variant="ghost" size="icon" onClick={logout} title="Cerrar sesión">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {/* En móvil el header va justo de espacio y esconde versión y correo:
          se muestran al pie, que ahí no compiten con la navegación. Con marca de
          empresa el pie se ve siempre, porque ahí va la firma del proveedor. */}
      <footer className={cn("border-t px-6 py-3", !muestraFirmaProveedor && "md:hidden")}>
        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-[10px] text-muted-foreground/70 md:hidden">
          <span className="font-mono" title="Versión desplegada (se genera en cada deploy)">
            v{__APP_BUILD__}
          </span>
          {appUser?.email && (
            <>
              <span aria-hidden>·</span>
              <span>{appUser.email}</span>
            </>
          )}
        </p>
        {muestraFirmaProveedor && (
          <p className="text-center text-[10px] text-muted-foreground/70">
            operado con {VENDOR_BRANDING.appName}
          </p>
        )}
      </footer>
      {/* Avisos de builds y publicaciones de apps, en cualquier pestaña. */}
      <BuildNotifier />
    </div>
  );
}
