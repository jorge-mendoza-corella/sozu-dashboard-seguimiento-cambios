import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, GitBranch, Users, GitCommit, LogOut, LayoutDashboard, HardHat, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { Button } from "@/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getHostingChannels, pendingDraft } from "@/lib/hostingChannels";
import { triggerPlayTracksSync } from "@/lib/playTracks";
import { getAvancesSettings, setAvancesDraftUrl } from "@/lib/avancesSettings";

// Sitio de avance de obra. El badge DRAFT (solo root) aparece únicamente
// cuando el canal de preview tiene contenido que todavía no se publica: eso lo
// determina el workflow programado comparando el release del canal contra el
// que está en vivo. La URL del canal también viene de ahí, porque cambia cada
// vez que se recrea; la constante es solo el respaldo si el sync aún no corrió.
const AVANCES_URL = "https://avances.sozu.com";
const AVANCES_SITE = "sozu-avances";
const AVANCES_DRAFT_FALLBACK = "https://sozu-avances--draft-u1wqsh7o.web.app";

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
  const qc = useQueryClient();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const navItems = NAV_ITEMS.filter((i) => i.show(appUser?.role, isRoot));

  // Draft del sitio de avances: solo interesa al root.
  const { data: hosting } = useQuery({
    queryKey: ["hosting-channels", AVANCES_SITE],
    queryFn: () => getHostingChannels(AVANCES_SITE),
    enabled: isRoot,
    refetchInterval: 5 * 60_000,
  });
  const { data: avances } = useQuery({
    queryKey: ["avances-settings"],
    queryFn: getAvancesSettings,
    enabled: isRoot,
    refetchInterval: 5 * 60_000,
  });
  const draft = pendingDraft(hosting);
  // El badge solo sale con un draft confirmado sin publicar: si el sync no
  // opinó, no se muestra (mostrarlo de más equivale a mandar a una versión
  // que ya es la pública).
  const showDraft = isRoot && !!draft;
  const draftUrl = draft?.url ?? avances?.draftUrl ?? AVANCES_DRAFT_FALLBACK;

  // La URL del canal cambia con cada draft nuevo y solo la Hosting API puede
  // descubrirla (permiso pendiente), así que el root puede pegarla a mano.
  const pedirDraftUrl = async () => {
    const actual = avances?.draftUrl ?? "";
    const url = window.prompt(
      "URL del canal draft de avances\n(Firebase le pone un hash distinto a cada draft nuevo)\n\nVacío = quitarla:",
      actual,
    );
    if (url === null) return;
    const limpia = url.trim();
    if (limpia && !/^https:\/\//.test(limpia)) {
      window.alert("La URL debe empezar con https://");
      return;
    }
    await setAvancesDraftUrl(limpia || null, appUser?.email ?? "");
    await qc.invalidateQueries({ queryKey: ["avances-settings"] });
    // Recalcular de inmediato con la URL nueva en vez de esperar al cron.
    triggerPlayTracksSync().catch(() => {});
    sessionStorage.removeItem("hosting-sync-pedido");
  };

  // El sync corre cada 15 min; al entrar, si el dato está viejo se pide uno
  // fresco para que el badge no sobreviva a una publicación reciente.
  useEffect(() => {
    if (!isRoot || !hosting) return;
    const age = hosting.updatedAt ? Date.now() - new Date(hosting.updatedAt).getTime() : Infinity;
    if (age < 10 * 60_000) return;
    if (sessionStorage.getItem("hosting-sync-pedido")) return;
    sessionStorage.setItem("hosting-sync-pedido", "1");
    triggerPlayTracksSync().catch(() => sessionStorage.removeItem("hosting-sync-pedido"));
  }, [isRoot, hosting]);

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
            {/* Sitio de avance de obra (aplicación aparte, se abre en otra pestaña) */}
            <span className="ml-1 flex items-center">
              <a
                href={AVANCES_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
                title="Avance de obra (versión publicada) — avances.sozu.com"
              >
                <HardHat className="h-4 w-4" />
                Avances
                <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
              {isRoot && !showDraft && (
                <button
                  type="button"
                  onClick={pedirDraftUrl}
                  className="-ml-1.5 rounded border border-transparent px-1 py-0.5 text-[10px] text-muted-foreground/50 transition-colors hover:border-border hover:text-foreground"
                  title={
                    "Sin borrador pendiente." +
                    (avances?.draftUrl ? `\nCanal vigilado: ${avances.draftUrl}` : "") +
                    "\n\nSi acabas de generar un draft nuevo, su URL cambió: pégala aquí."
                  }
                >
                  draft?
                </button>
              )}
              {showDraft && (
                <a
                  href={draftUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="-ml-1.5 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-700 no-underline transition-colors hover:bg-amber-200 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
                  onContextMenu={(e) => { e.preventDefault(); void pedirDraftUrl(); }}
                  title={
                    (draft?.title
                      ? `Borrador pendiente de aprobar: ${draft.title}`
                      : "Versión borrador del reporte de avances (solo tú la ves)") +
                    "\nClic derecho para cambiar la URL del canal."
                  }
                >
                  DRAFT
                </a>
              )}
            </span>
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
    </div>
  );
}
