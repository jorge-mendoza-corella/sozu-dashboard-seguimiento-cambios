import { Link, useLocation } from "react-router-dom";
import { Activity, GitBranch, Users, GitCommit, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

const NAV_ITEMS = [
  { to: "/", label: "CI/CD", icon: GitBranch },
  { to: "/contributors", label: "Contribuidores", icon: GitCommit },
  { to: "/users", label: "Usuarios", icon: Users },
];

// Rutas que un viewer no puede ver en el nav.
const VIEWER_HIDDEN = new Set(["/users"]);

interface Props { children: React.ReactNode }

export function AppLayout({ children }: Props) {
  const { appUser, logout } = useAuth();
  const { pathname } = useLocation();
  const isViewer = appUser?.role === "viewer";
  const navItems = NAV_ITEMS.filter((i) => !isViewer || !VIEWER_HIDDEN.has(i.to));

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
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:block">{appUser?.email}</span>
            <Button variant="ghost" size="icon" onClick={logout} title="Cerrar sesión">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
