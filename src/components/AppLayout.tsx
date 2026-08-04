import { Link, useLocation } from "react-router-dom";
import { Activity, GitBranch, Users, GitCommit, LogOut, LayoutDashboard, HardHat, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { Button } from "@/components/ui/button";
import { AvancesDraftBadge } from "@/components/AvancesDraftBadge";
import { BuildNotifier } from "@/components/codemagic/BuildNotifier";

// Sitio de avance de obra. El badge de borrador vive en AvancesDraftBadge.
const AVANCES_URL = "https://avances.sozu.com";

// `show(role, isRoot)` decide la visibilidad de cada item en el nav.
const NAV_ITEMS = [
  { to: "/resumen", label: "Resumen", icon: LayoutDashboard, show: () => true },
  { to: "/", label: "CI/CD", icon: GitBranch, show: () => true },
  { to: "/contributors", label: "Contribuidores", icon: GitCommit, show: (_r: string | undefined, root: boolean) => root },
  { to: "/users", label: "Usuarios", icon: Users, show: (_r: string | undefined, root: boolean) => root },
];

interface Props { children: React.ReactNode }

export function AppLayout({ children }: Props) {
  const { appUser, logout } = useAuth();
  const { pathname } = useLocation();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const navItems = NAV_ITEMS.filter((i) => i.show(appUser?.role, isRoot));

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top nav */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-4 px-6">
          <Link to="/" className="flex items-center gap-2 font-bold text-primary no-underline">
            <Activity className="h-5 w-5" />
            SOZU Tracker
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
            ) : (
              <a
                href={AVANCES_URL}
                target="_blank"
                rel="noreferrer"
                className="ml-1 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
                title="Avance de obra — avances.sozu.com"
              >
                <HardHat className="h-4 w-4" />
                Avances
                <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
            )}
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
      {/* Avisos de builds y publicaciones de apps, en cualquier pestaña. */}
      <BuildNotifier />
    </div>
  );
}
