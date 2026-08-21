import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Activity, GitBranch, Users, GitCommit, LogOut, LayoutDashboard, HardHat, ExternalLink,
  TrendingUp, Settings, Eye, X, Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useImpersonation } from "@/hooks/useImpersonation";
import { useBranding, useApplyBranding } from "@/hooks/useBranding";
import { VENDOR_SIGNATURE } from "@/lib/branding";
import { useAvancesAccess, AVANCES_URL_DEFAULT } from "@/hooks/useClients";
import { canAdminister, isRootAdmin } from "@/lib/firestoreUsers";
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
  // Contribuidores y Usuarios los necesita también el administrador de empresa:
  // son SU gente. Cada pantalla se acota sola a sus empresas.
  { to: "/contributors", label: "Contribuidores", icon: GitCommit, show: (v: NavVisibility) => v.admin },
  // Usuarios vuelve a ser del admin global. El administrador de empresa ya sabe
  // gestionar a sus viewers —el código y las reglas están—, pero se deja apagado
  // hasta decidirlo: abrirlo ahora le pinta pantallas nuevas a cuentas que
  // llevan meses viendo otra cosa.
  { to: "/users", label: "Usuarios", icon: Users, show: (v: NavVisibility) => v.admin },
  // Negocio sí es del dueño del servicio —tarifas y datos fiscales de la
  // cartera— y no la ve nadie más. Configuración la comparten: el admin global
  // ve todas las pestañas y el de empresa solo las suyas.
  { to: "/configuracion", label: "Configuración", icon: Settings, show: (v: NavVisibility) => v.admin },
];

interface Props { children: React.ReactNode }

export function AppLayout({ children }: Props) {
  const { appUser, realUser, logout } = useAuth();
  // Impersonación: el perfil ya viene cambiado desde `useAuth`, así que aquí
  // solo hace falta el aviso y la salida. Se muestra SIEMPRE mientras dure: sin
  // él es fácil creer que algo funciona para el cliente cuando en realidad
  // funcionó porque las reglas siguen viendo al root.
  const { email: viendoComo, salir } = useImpersonation();
  const impersonando = !!viendoComo && appUser?.email === realUser?.email && appUser !== realUser;
  const { pathname } = useLocation();
  // Menú desplegado en móvil. En la barra los items no caben —siete con icono y
  // texto pasan de 700px— y se salían por la derecha: quedaban fuera de la
  // pantalla, sin scroll que los alcanzara, y el usuario veía media palabra
  // cortada en el borde. A partir de `md` la barra vuelve a mostrarlos todos.
  const [menuAbierto, setMenuAbierto] = useState(false);
  const isRoot = isRootAdmin(appUser);
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

  // Clases de cada link, compartidas por la barra y el menú: un item activo
  // tiene que verse igual en los dos, o el menú parece otra navegación.
  const claseItem = (activo: boolean, enMenu: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors",
      enMenu && "w-full py-2.5",
      activo ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    );

  return (
    <div className="min-h-screen flex flex-col">
      {impersonando && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-400 px-4 py-1.5 text-[11px] font-semibold text-amber-950">
          <Eye className="h-3.5 w-3.5" />
          Estás viendo el dashboard como {viendoComo}. Lo que hagas se sigue guardando
          como {realUser?.email}, y las reglas siguen viéndote como tú.
          <button
            type="button"
            onClick={salir}
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-950/10 px-2 py-0.5 font-bold hover:bg-amber-950/20"
          >
            <X className="h-3 w-3" /> Salir
          </button>
        </div>
      )}
      {/* Top nav */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-4 sm:gap-4 sm:px-6">
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
          {/* Barra completa solo desde `md`: por debajo no caben y se salían
              fuera de la pantalla, sin scroll que las alcanzara. */}
          <nav className="ml-2 hidden items-center gap-1 md:flex">
            {navItems.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} className={claseItem(pathname === to, false)}>
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
            {/* El botón del menú va al final y solo en móvil: es lo último que se
                necesita en escritorio y lo primero que se busca en el teléfono. */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={menuAbierto}
              aria-label={menuAbierto ? "Cerrar el menú" : "Abrir el menú"}
              title={menuAbierto ? "Cerrar el menú" : "Abrir el menú"}
              onClick={() => setMenuAbierto((v) => !v)}
            >
              {menuAbierto ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Menú de móvil: los mismos items, uno por renglón. Se cierra al elegir
            —dejarlo abierto tapa justo la pantalla a la que se acaba de llegar—
            y también al tocar fuera. */}
        {menuAbierto && (
          <nav className="flex flex-col gap-0.5 border-t px-4 py-2 md:hidden">
            {navItems.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={claseItem(pathname === to, true)}
                onClick={() => setMenuAbierto(false)}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
            {isRoot ? (
              <div onClick={() => setMenuAbierto(false)}>
                <AvancesDraftBadge email={appUser?.email ?? ""} />
              </div>
            ) : avances.allowed ? (
              <a
                href={avancesUrl}
                target="_blank"
                rel="noreferrer"
                className={claseItem(false, true)}
                onClick={() => setMenuAbierto(false)}
              >
                <HardHat className="h-4 w-4" />
                Avances
                <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
            ) : null}
          </nav>
        )}
      </header>
      {/* Capa para cerrar tocando fuera. Va debajo del header (que es sticky con
          z-50) para no tapar el propio botón de cerrar. */}
      {menuAbierto && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-40 cursor-default md:hidden"
          onClick={() => setMenuAbierto(false)}
        />
      )}
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
            {VENDOR_SIGNATURE}
          </p>
        )}
      </footer>
      {/* Avisos de builds y publicaciones de apps, en cualquier pestaña. */}
      <BuildNotifier />
    </div>
  );
}
