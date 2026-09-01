import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle, CheckCircle2, RefreshCw, Loader2,
  GitBranch, GitPullRequest, Zap,
  EyeOff, ChevronDown, ChevronUp, Rocket, ArrowRight,
  X, CheckCircle, XCircle, ArrowUpCircle,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BranchRow } from "./BranchRow";
import { PRList } from "./PRList";
import { WorkflowBadge } from "./WorkflowBadge";
import { DeployMetaTooltip } from "./DeployMetaTooltip";
import { AvisoDeploy } from "./AvisoDeploy";
import type { AvisosDelProyecto } from "@/hooks/useAvisos";
import { FrontInfoBar } from "./FrontInfoBar";
import type { FrontVersion } from "@/lib/frontVersions";
import type { BranchInfo, RepoStatus } from "@/lib/github";
import { createPR, hasFailingDeploy, getBranchCommitAuthors, getPendingReleasePRs, type ApproverAuth, type PRWithCommits } from "@/lib/github";
import { NO_PERMISSIONS, type CicdPermissions } from "@/lib/firestoreUsers";
import { getAllContributorPhones } from "@/lib/firestoreContributors";

// El fallback, cuando el proyecto no tiene `notifyAuthors` configurados, era
// esta lista de cuatro logins escrita a mano:
//
//   ["joseramonescobar", "tomaspeterson-prog", "Eddys912", "abelsalazar-cmd"]
//
// Quien no estuviera ahí no se podía notificar, y como la lista no se toca al
// entrar alguien nuevo, en la práctica nunca crecía: se preguntó por qué no
// aparecía una persona del equipo, y la respuesta era que nadie la había escrito
// en este archivo. Ahora el fallback son los contribuidores que tienen teléfono
// capturado en Contribuidores, que es exactamente el conjunto de gente a la que
// se le PUEDE mandar el aviso — ofrecer a alguien sin teléfono sería ofrecer un
// aviso que no va a llegar.

function sortBranches(branches: BranchInfo[]): BranchInfo[] {
  return [
    ...branches.filter((b) => b.name === "main"),
    ...branches.filter((b) => b.name === "dev"),
    ...branches.filter((b) => b.name !== "main" && b.name !== "dev"),
  ];
}

function getOverallState(status: RepoStatus): "ok" | "devPending" | "pending" | "failing" | "error" {
  if (status.error) return "error";
  if (hasFailingDeploy(status.latestRuns)) return "failing";
  if (status.openPRs.length > 0) return "pending";
  const dev = status.branches.find((b) => b.name === "dev");
  if ((dev?.aheadOfMain ?? 0) > 0) return "devPending";
  return "ok";
}

interface Props {
  status: RepoStatus;
  onRefetch?: () => void;
  /** Viewer: solo main/dev y sin ramas ocultables (restricción visual). */
  readOnly?: boolean;
  /** Permisos granulares de acciones (crear PR, aprobar, merge dev/main). */
  perms?: CicdPermissions;
  /** Aprobador configurado del proyecto (token+login de GitHub). */
  approver?: ApproverAuth | null;
  /** Credenciales de los usuarios del dashboard: firman como CODEOWNER si les toca. */
  codeOwnerAuths?: ApproverAuth[];
  /** URL del front que publica el repo; con ella el repo cuenta como front. */
  frontUrl?: string;
  /** Versión que sirve ese front (la lee el sync; ver lib/frontVersions). */
  frontVersion?: FrontVersion | null;
  /** Solo proyectos app: paquete Android y bundle iOS, para las versiones de tienda. */
  androidPackage?: string;
  iosBundleId?: string;
  /** Login de GitHub del usuario logueado — para el permiso "ver cambios de otros". */
  selfLogin?: string | null;
  /** Logins seleccionables como autor extra al crear PR (configurados por proyecto). */
  notifyAuthors?: string[];
  /**
   * Nombre canónico si el repo ya se renombró en GitHub (lo detecta
   * `useRepoRenames`). Con él la card avisa que el alta quedó con el nombre viejo.
   */
  renamedTo?: { owner: string; repo: string } | null;
  /**
   * A quién le toca el aviso de WhatsApp de este proyecto. Solo se usa cuando
   * el deploy no dejó registro propio: entonces la tarjeta habla en futuro en
   * vez de afirmar una entrega que nadie comprobó.
   */
  avisos?: AvisosDelProyecto;
}

export function RepoCard({ status, onRefetch, readOnly = false, perms = NO_PERMISSIONS, approver = null, codeOwnerAuths = [], selfLogin = null, notifyAuthors = [], frontUrl, frontVersion = null, androidPackage, iosBundleId, renamedTo = null, avisos }: Props) {
  // Sin el permiso viewOthers el usuario solo ve SUS ramas y PRs
  // (main/dev siempre visibles: son estado compartido del repo).
  const canViewOthers = perms.viewOthers || !selfLogin;

  // Gente a la que se le puede mandar un WhatsApp: la que tiene teléfono en
  // Contribuidores. Es el fallback cuando el proyecto no configuró sus propios
  // `notifyAuthors`. Una sola consulta compartida por todas las tarjetas.
  const { data: telefonos = {}, isLoading: cargandoNotificables } = useQuery({
    queryKey: ["contributor-phones"],
    queryFn: getAllContributorPhones,
    staleTime: 10 * 60_000,
  });
  const notificables = Object.keys(telefonos).sort((a, b) => a.localeCompare(b));
  const scopedPRs = canViewOthers
    ? status.openPRs
    : status.openPRs.filter((pr) => pr.author === selfLogin);
  const [newPR, setNewPR] = useState<{
    head: string; title: string; base: string; body: string;
    authorStep?: boolean;
    /** Autores detectados de los commits (null = detectando). Se notifican SIEMPRE. */
    detectedAuthors?: string[] | null;
    /** Autores extra elegidos a mano (multiseleccion). */
    selectedAuthors: string[];
    /** dev->main: PRs a dev que este release incluye (null = cargando). */
    releasePRs?: PRWithCommits[] | null;
  } | null>(null);
  const [expandedReleasePRs, setExpandedReleasePRs] = useState<Set<number>>(new Set());
  const [newPRLoading, setNewPRLoading] = useState(false);
  const [newPRResult, setNewPRResult] = useState<{ ok: boolean; msg: string; url?: string } | null>(null);
  // Optimistic: ramas donde ya se creó un PR pero el refetch aún no llegó
  const [optimisticPRHeads, setOptimisticPRHeads] = useState<Set<string>>(new Set());

  // Limpia optimisticPRHeads cuando el refetch ya trajo el PR real
  useEffect(() => {
    const realHeads = new Set(scopedPRs.map((pr) => pr.head));
    setOptimisticPRHeads((prev) => {
      const next = new Set([...prev].filter((h) => !realHeads.has(h)));
      return next.size === prev.size ? prev : next;
    });
  }, [scopedPRs]);

  const openCreatePR = (branchName: string) => {
    const defaultBase = branchName === "dev" ? "main" : "dev";
    // TODOS los repos pasan por el paso de autores, `sozu-admin` incluido. Este
    // estaba exento —se saltaba el paso y creaba el PR sin marcadores—, lo que
    // dejaba dos cosas rotas: sus PRs no notificaban a nadie, y no había dónde
    // agregar a alguien más aunque se quisiera. Que los autores se detecten solos
    // no quita la necesidad de sumar a un tercero.
    setNewPR({
      head: branchName, title: branchName, base: defaultBase, body: "",
      authorStep: true,
      detectedAuthors: null,
      selectedAuthors: [],
    });
    setNewPRResult(null);
    // Detectar autores reales de los commits del PR (head vs base).
    getBranchCommitAuthors(status.owner, status.repo, defaultBase, branchName).then((logins) => {
      setNewPR((p) => (p && p.head === branchName ? { ...p, detectedAuthors: logins } : p));
    });
    if (branchName === "dev") {
      // dev->main: cargar el contenido del release (PRs a dev + commits) y
      // prellenar la descripcion con una entrada por PR incluido, usando la
      // descripcion (obligatoria) de cada uno — la notificacion de deploy la usa.
      setNewPR((p) => (p && p.head === branchName ? { ...p, releasePRs: null } : p));
      setExpandedReleasePRs(new Set());
      getPendingReleasePRs(status.owner, status.repo).then((prs) => {
        setNewPR((p) => {
          if (!p || p.head !== branchName) return p;
          const prefill = prs
            .map((pr) => `- PR #${pr.number} ${pr.title} (@${pr.author}): ${pr.description || "(sin descripcion)"}`)
            .join("\n");
          return { ...p, releasePRs: prs, body: p.body || prefill };
        });
      });
    }
  };

  const closeCreatePR = () => {
    setNewPR(null);
    setNewPRResult(null);
    setNewPRLoading(false);
  };

  const handleCreatePR = async () => {
    if (!newPR || !newPR.title.trim() || !newPR.body.trim()) return;
    setNewPRLoading(true);
    try {
      let body = newPR.body.trim();
      // Autores del PR: detectados por commits + agregados a mano (sin duplicar).
      // Una línea <!-- pr_author --> por autor: los workflows notifican a todos.
      const authors = [...new Set([...(newPR.detectedAuthors ?? []), ...newPR.selectedAuthors])];
      if (authors.length > 0) {
        const mention = `> 👤 Cambios de: ${authors.map((a) => `@${a}`).join(", ")}`;
        const markers = authors.map((a) => `<!-- pr_author: ${a} -->`).join("\n");
        body = body ? `${body}\n\n${mention}\n${markers}` : `${mention}\n${markers}`;
      }
      const { number, url } = await createPR(status.owner, status.repo, newPR.title.trim(), newPR.head, newPR.base, body, approver?.login);
      setNewPRResult({ ok: true, msg: `PR #${number} creado`, url });
      setOptimisticPRHeads((prev) => new Set([...prev, newPR.head]));
      setTimeout(() => { closeCreatePR(); onRefetch?.(); }, 2500);
    } catch (e) {
      setNewPRResult({ ok: false, msg: e instanceof Error ? e.message : "Error al crear PR" });
    } finally {
      setNewPRLoading(false);
    }
  };

  const [hiddenBranches, setHiddenBranches] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`hidden-branches-${status.repo}`);
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [showHidden, setShowHidden] = useState(false);

  const hideBranch = (name: string) => {
    setHiddenBranches((prev) => {
      const next = new Set(prev);
      next.add(name);
      localStorage.setItem(`hidden-branches-${status.repo}`, JSON.stringify([...next]));
      return next;
    });
  };

  const unhideBranch = (name: string) => {
    setHiddenBranches((prev) => {
      const next = new Set(prev);
      next.delete(name);
      localStorage.setItem(`hidden-branches-${status.repo}`, JSON.stringify([...next]));
      return next;
    });
  };

  // main y dev siempre visibles (en el orden de sortBranches), sin importar
  // lo guardado en localStorage. Solo las demás ramas pueden ocultarse.
  const isProtectedBranch = (name: string) => name === "main" || name === "dev";
  const scopedBranches = canViewOthers
    ? status.branches
    : status.branches.filter((b) => isProtectedBranch(b.name) || b.lastCommitAuthor === selfLogin);
  const sorted = sortBranches(scopedBranches);
  // Viewer: solo main y dev, sin ramas ocultables.
  const visibleBranches = readOnly
    ? sorted.filter((b) => isProtectedBranch(b.name))
    : sorted.filter((b) => isProtectedBranch(b.name) || !hiddenBranches.has(b.name));
  const hiddenList = readOnly ? [] : sorted.filter((b) => !isProtectedBranch(b.name) && hiddenBranches.has(b.name));

  const branchesWithPR = new Set([...scopedPRs.map((pr) => pr.head), ...optimisticPRHeads]);
  const hasDevToMainPR = scopedPRs.some((pr) => pr.head === "dev" && pr.base === "main") || optimisticPRHeads.has("dev");
  const devBranch = status.branches.find((b) => b.name === "dev");
  const devAheadOfMain = devBranch?.aheadOfMain ?? 0;

  // Estado con los datos que el usuario puede ver; si lo pendiente es de
  // OTROS (PRs ajenos o dev movido por otro), se etiqueta explícitamente.
  let state: ReturnType<typeof getOverallState> | "pendingOthers" =
    getOverallState({ ...status, openPRs: scopedPRs });
  if (!canViewOthers && !status.error) {
    const othersPRs = status.openPRs.length > scopedPRs.length;
    const devByOther =
      state === "devPending" && !!devBranch?.lastCommitAuthor && devBranch.lastCommitAuthor !== selfLogin;
    if ((state === "ok" && othersPRs) || devByOther) state = "pendingOthers";
  }
  const hasPRs = scopedPRs.length > 0;

  const isDeployingToMain = status.latestRuns.some(
    (r) => (r.status === "in_progress" || r.status === "queued") && r.headBranch === "main"
  );
  const isDeployingToDev = !isDeployingToMain && status.latestRuns.some(
    (r) => (r.status === "in_progress" || r.status === "queued") && r.headBranch === "dev"
  );
  const isCIRunning = isDeployingToMain || isDeployingToDev || status.latestRuns.some(
    (r) => r.status === "in_progress" || r.status === "queued"
  );
  // El deploy que se está viendo ahora mismo, y el último que terminó: sobre
  // esos dos se dice a quién se le avisa y a quién se le avisó. Preguntarlo por
  // cada run de la lista llenaría la tarjeta de líneas repetidas.
  const runEnCurso = status.latestRuns.find(
    (r) => r.status === "in_progress" || r.status === "queued",
  );
  const ultimoTerminado = status.latestRuns.find((r) => r.status === "completed");

  const stateConfig = {
    ok:         { icon: CheckCircle2,   color: "text-green-600",        label: "Todo en orden",          badge: "success"     as const },
    devPending: { icon: ArrowUpCircle,  color: "text-blue-600",         label: "Dev por pasar a PRD",    badge: "info"        as const },
    pending:    { icon: GitPullRequest, color: "text-amber-600",        label: "Cambios pendientes",     badge: "warning"     as const },
    pendingOthers: { icon: GitPullRequest, color: "text-slate-500",      label: "Cambios pendientes de otro usuario", badge: "secondary" as const },
    failing:    { icon: AlertCircle,    color: "text-red-600",          label: "CI fallando",            badge: "destructive" as const },
    error:      { icon: AlertCircle,    color: "text-muted-foreground", label: "Error al cargar",        badge: "outline"     as const },
  }[state];

  const StateIcon = stateConfig.icon;

  const accentColor = isDeployingToMain
    ? "from-emerald-500 via-emerald-400 to-teal-400"
    : isDeployingToDev
      ? "from-blue-500 to-blue-400"
      : {
          ok:         "from-emerald-500 to-emerald-400",
          devPending: "from-blue-500 to-blue-400",
          pending:    "from-amber-500 to-amber-400",
          pendingOthers: "from-slate-400 to-slate-300",
          failing:    "from-red-500 to-red-400",
          error:      "from-slate-400 to-slate-300",
        }[state];

  return (
    <Card className={cn(
      "flex flex-col h-full transition-all",
      isDeployingToMain && "ring-4 ring-emerald-500 ring-offset-2 shadow-xl shadow-emerald-500/25",
      isDeployingToDev && !isDeployingToMain && "ring-2 ring-blue-400 ring-offset-2",
      !isDeployingToMain && !isDeployingToDev && state === "devPending" && "ring-2 ring-blue-400 ring-offset-2",
      !isDeployingToMain && !isDeployingToDev && hasPRs && "ring-2 ring-amber-400 ring-offset-2",
    )}>
      {/* Acento superior — animado cuando hay deploy a main */}
      <div className={cn(
        "h-1.5 w-full bg-gradient-to-r",
        accentColor,
        isDeployingToMain && "animate-pulse",
      )} />

      {/* ══════════════════════════════════════════════
          BANNER DEPLOY → MAIN  (solo cuando activo)
          ══════════════════════════════════════════════ */}
      {isDeployingToMain && (
        <div className="relative overflow-hidden bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 px-4 py-3">
          {/* Shimmer sweep */}
          <div className="pointer-events-none absolute inset-0 -translate-x-full animate-[shimmer_2.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/15 to-transparent" />
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 ring-1 ring-white/30">
                <Rocket className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-emerald-100/80 leading-none mb-0.5">
                  Deploy en progreso
                </p>
                <div className="flex items-center gap-1.5">
                  <span className="text-lg font-black text-white tracking-tight leading-none">MAIN</span>
                  <ArrowRight className="h-4 w-4 text-white/80" />
                  <span className="rounded bg-white/20 px-1.5 py-0.5 text-xs font-bold text-white ring-1 ring-white/30">
                    PRD
                  </span>
                </div>
              </div>
            </div>
            <Loader2 className="h-5 w-5 text-white/80 animate-spin shrink-0" />
          </div>
          {/* A quién le va a llegar el aviso cuando termine. Es justo lo que uno
              se pregunta mirando la barra correr, y estaba escondido tras el
              hover de un icono de 12px. */}
          {runEnCurso && (
            <div className="relative mt-2">
              <AvisoDeploy owner={status.owner} repo={status.repo} run={runEnCurso} avisos={avisos} sobreFondoOscuro />
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════
          BANNER TODO EN PRD  (estado ok, sin deploy activo)
          ══════════════════════════════════════════════ */}
      {state === "ok" && !isDeployingToMain && (
        <div className="bg-gradient-to-r from-emerald-50 via-white to-teal-50 dark:from-emerald-950/40 dark:via-slate-900 dark:to-teal-950/30 border-b border-emerald-200/70 dark:border-emerald-800/30 px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50 ring-1 ring-emerald-300/70 dark:ring-emerald-700/50">
                <Rocket className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600/70 dark:text-emerald-400/60 leading-none mb-0.5">
                  En producción
                </p>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-black text-emerald-700 dark:text-emerald-300 tracking-tight leading-none">MAIN</span>
                  <ArrowRight className="h-3 w-3 text-emerald-500/70 dark:text-emerald-500" />
                  <span className="rounded bg-emerald-200/80 dark:bg-emerald-800/50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-300/50 dark:ring-emerald-700/40">
                    PRD
                  </span>
                </div>
              </div>
            </div>
            <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
          </div>
        </div>
      )}

      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {isCIRunning
              ? <Loader2 className={cn("h-5 w-5 shrink-0 animate-spin", isDeployingToMain ? "text-emerald-500" : "text-blue-500")} />
              : <StateIcon className={`h-5 w-5 shrink-0 ${stateConfig.color}`} />}
            <CardTitle className="text-base truncate">{status.label}</CardTitle>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isDeployingToMain && (
              <Badge className="bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-300 dark:border-emerald-700/50 text-[10px] gap-1">
                <Rocket className="h-2.5 w-2.5" />
                → PRD
              </Badge>
            )}
            {isDeployingToDev && (() => {
              const activeRun = status.latestRuns.find(
                (r) => (r.status === "in_progress" || r.status === "queued") && r.headBranch === "dev",
              );
              const chip = (
                <Badge variant="info" className="text-[10px] gap-1">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  → DEV
                </Badge>
              );
              return activeRun ? (
                <DeployMetaTooltip owner={status.owner} repo={status.repo} run={activeRun} avisos={avisos}>
                  {chip}
                </DeployMetaTooltip>
              ) : chip;
            })()}
            {!isDeployingToMain && !isDeployingToDev && isCIRunning && (
              <Badge variant="info" className="text-[10px]">CI corriendo</Badge>
            )}
            <Badge variant={stateConfig.badge} className="text-[10px]">{stateConfig.label}</Badge>
          </div>
        </div>
        {status.error && <p className="text-xs text-destructive mt-1">{status.error}</p>}
        {/* Renombrado en GitHub: el alta del dashboard quedó con el nombre viejo.
            Hoy GitHub redirige, pero si nadie lo actualiza el repo puede
            desaparecer de las tarjetas sin dejar rastro de por qué. */}
        {renamedTo && (
          <div className="mt-1.5 flex">
            <Badge
              className="gap-1 border-amber-300 bg-amber-100 text-[10px] text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/50 dark:text-amber-300"
              title={`El dashboard lo tiene dado de alta como ${status.owner}/${status.repo}. Hasta actualizar el nombre en Gestionar → Repositorios, el dashboard puede dejar de verlo (GitHub redirige el nombre viejo, pero deja de hacerlo si alguien crea otro repo con ese nombre).`}
            >
              <AlertCircle className="h-2.5 w-2.5 shrink-0" />
              renombrado en GitHub →{" "}
              {renamedTo.owner.toLowerCase() === status.owner.toLowerCase()
                ? renamedTo.repo
                : `${renamedTo.owner}/${renamedTo.repo}`}
            </Badge>
          </div>
        )}
        {/* Front del repo: link, copiar y versión servida (más tiendas si es app). */}
        {frontUrl && (
          <div className="mt-2">
            <FrontInfoBar
              frontUrl={frontUrl}
              frontVersion={frontVersion}
              androidPackage={androidPackage}
              iosBundleId={iosBundleId}
            />
          </div>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-4 flex-1">
        {/* Deploy en curso que NO va a main: a quién se le va a avisar.
            El de main lo dice en su banner verde, pero un deploy a dev solo
            tenía un chip "→ DEV" en la cabecera y ningún lugar donde decirlo,
            así que mientras corría no había forma de saber a quién iba a
            llegarle el aviso — que es justo cuando uno se lo pregunta. */}
        {runEnCurso && !isDeployingToMain && (
          <AvisoDeploy
            owner={status.owner}
            repo={status.repo}
            run={runEnCurso}
            avisos={avisos}
            conEtiquetaDelRun
          />
        )}

        {/* Ramas */}
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            <GitBranch className="h-3.5 w-3.5" />
            Ramas ({visibleBranches.length}{hiddenList.length > 0 ? `+${hiddenList.length}` : ""})
          </h4>
          <div className="space-y-0">
            {visibleBranches.map((b) => {
              const isDevBranch = b.name === "dev";
              const showCreatePR = perms.createPR && (isDevBranch
                ? devAheadOfMain > 0 && !hasDevToMainPR && !isDeployingToDev
                : !branchesWithPR.has(b.name) && b.name !== "main");
              return (
                <BranchRow
                  key={b.name}
                  branch={b}
                  hasPR={branchesWithPR.has(b.name)}
                  onHide={readOnly || isProtectedBranch(b.name) ? undefined : () => hideBranch(b.name)}
                  onCreatePR={showCreatePR ? () => openCreatePR(b.name) : undefined}
                  alwaysShowCreatePR={isDevBranch && perms.createPR}
                />
              );
            })}
          </div>

          {hiddenList.length > 0 && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2 px-1 transition-colors"
            >
              <EyeOff className="h-3 w-3" />
              {hiddenList.length} {hiddenList.length === 1 ? "rama oculta" : "ramas ocultas"}
              {showHidden
                ? <ChevronUp className="h-3 w-3 ml-0.5" />
                : <ChevronDown className="h-3 w-3 ml-0.5" />}
            </button>
          )}
          {showHidden && hiddenList.length > 0 && (
            <div className="mt-1">
              {hiddenList.map((b) => (
                <BranchRow key={b.name} branch={b} onUnhide={() => unhideBranch(b.name)} />
              ))}
            </div>
          )}

          {/* Panel de crear PR */}
          {newPR && (
            <div className="mt-3 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/60 dark:bg-violet-900/10 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <GitPullRequest className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                  <span className="text-xs font-semibold text-violet-800 dark:text-violet-200">
                    Crear PR desde <span className="font-mono">{newPR.head}</span>
                  </span>
                </div>
                <button onClick={closeCreatePR} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {newPRResult ? (
                <div className={cn(
                  "flex items-center gap-2 p-2 rounded text-xs font-medium",
                  newPRResult.ok ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                                 : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
                )}>
                  {newPRResult.ok ? <CheckCircle className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                  {newPRResult.msg}
                  {newPRResult.url && (
                    <a href={newPRResult.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-[10px] underline">
                      Ver PR
                    </a>
                  )}
                </div>
              ) : newPR.authorStep ? (
                /* Paso 1: autores del PR (detectados por commits + extras multiselección) */
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground font-medium">
                    Se notificará automáticamente a los autores de los commits:
                  </p>
                  {newPR.detectedAuthors == null ? (
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> detectando autores…
                    </p>
                  ) : newPR.detectedAuthors.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">Sin autores detectados en los commits.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {(newPR.detectedAuthors ?? []).map((login) => (
                        <span
                          key={login}
                          className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                        >
                          ✓ @{login}
                        </span>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const base = notifyAuthors.length > 0 ? notifyAuthors : notificables;
                    const options = base.filter((l) => !(newPR.detectedAuthors ?? []).includes(l));
                    if (options.length === 0) {
                      // Distinguir "todavía cargando" de "no hay a quién ofrecer"
                      // evita leerlo como que la lista se quedó corta.
                      return cargandoNotificables ? (
                        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> cargando contribuidores…
                        </p>
                      ) : notifyAuthors.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground italic">
                          Nadie más a quien avisar: ningún contribuidor tiene teléfono capturado en
                          Contribuidores.
                        </p>
                      ) : null;
                    }
                    return (
                      <>
                        <p className="text-[11px] text-muted-foreground font-medium">
                          ¿Notificar a alguien más? (opcional, multiselección)
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {options.map((login) => {
                            const on = newPR.selectedAuthors.includes(login);
                            return (
                              <button
                                key={login}
                                onClick={() =>
                                  setNewPR((p) => p ? {
                                    ...p,
                                    selectedAuthors: on
                                      ? p.selectedAuthors.filter((x) => x !== login)
                                      : [...p.selectedAuthors, login],
                                  } : null)
                                }
                                className={cn(
                                  "rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors",
                                  on
                                    ? "border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-700/60 dark:bg-violet-900/40 dark:text-violet-300"
                                    : "border-border text-muted-foreground hover:bg-muted",
                                )}
                              >
                                @{login}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                  <button
                    onClick={() => setNewPR((p) => p ? { ...p, authorStep: false } : null)}
                    disabled={newPR.detectedAuthors == null}
                    className="w-full text-[11px] font-medium text-violet-700 dark:text-violet-300 py-1.5 rounded border border-violet-200 dark:border-violet-700/40 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors disabled:opacity-50"
                  >
                    Continuar
                  </button>
                </div>
              ) : (
                /* Paso 2: formulario */
                <div className="space-y-2">
                  {(() => {
                    const authors = [...new Set([...(newPR.detectedAuthors ?? []), ...newPR.selectedAuthors])];
                    if (authors.length === 0) return null;
                    return (
                      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1 rounded bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-700/40">
                        <span className="text-[10px] text-muted-foreground">Se notificará a:</span>
                        <span className="text-[11px] font-semibold font-mono text-violet-700 dark:text-violet-300">
                          {authors.map((a) => `@${a}`).join(", ")}
                        </span>
                        <button
                          onClick={() => setNewPR((p) => p ? { ...p, authorStep: true } : null)}
                          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline"
                        >
                          cambiar
                        </button>
                      </div>
                    );
                  })()}
                  {/* El TÍTULO, y dice que lo es.
                      Venía prellenado con el nombre de la rama y sin etiqueta,
                      justo debajo de "Crear PR desde <rama>": se leía como el
                      campo de la rama de origen, y editarlo parecía cambiar de
                      dónde sale el PR. No lo cambia —el origen es la rama del
                      botón que se apretó y no se puede tocar—, pero un campo que
                      parece hacer algo que no hace es peor que no tenerlo. */}
                  <label className="flex items-center gap-2">
                    <span className="shrink-0 text-[10px] text-muted-foreground">Título:</span>
                    <input
                      type="text"
                      value={newPR.title}
                      onChange={(e) => setNewPR((p) => p ? { ...p, title: e.target.value } : null)}
                      placeholder="Título del PR"
                      title="Título del PR. La rama de origen no se elige aquí: es la del botón que abriste."
                      className="flex-1 rounded border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-violet-400"
                    />
                  </label>

                  {/* La rama de origen, en solo lectura y al lado del destino:
                      el flujo completo se lee de un vistazo (origen → destino) y
                      queda claro que ninguno de los dos se elige. */}
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[10px] text-muted-foreground">Desde:</span>
                    <span
                      className="flex-1 rounded border bg-muted/40 px-2 py-1 font-mono text-xs"
                      title="Sale de la rama cuyo botón abriste; para otra rama, usa su propio botón."
                    >
                      {newPR.head}
                    </span>
                  </div>
                  {/* El destino no es una elección libre: el flujo es rama de
                      trabajo → dev → main. El desplegable ofrecía TODAS las
                      ramas del repo, así que desde una rama de trabajo se podía
                      apuntar a main —saltándose dev y su revisión— o a la rama
                      de otra persona, y eso último ni siquiera es un error que
                      se note: el PR se crea y parece normal.
                      Desde `dev` el único destino es `main`; desde cualquier
                      otra, `dev`. Con un solo destino posible el selector deja
                      de ser un menú y pasa a decir a dónde va. */}
                  {(() => {
                    const destinos = newPR.head === "dev" ? ["main"] : ["dev"];
                    const existe = status.branches.some((b) => b.name === destinos[0]);
                    return (
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 text-[10px] text-muted-foreground">Base:</span>
                        {existe ? (
                          <span
                            className="flex-1 rounded border bg-muted/40 px-2 py-1 font-mono text-xs"
                            title={
                              newPR.head === "dev"
                                ? "Un PR desde dev va a main: es el paso de release."
                                : "Una rama de trabajo entra por dev. A main solo se llega desde dev."
                            }
                          >
                            {destinos[0]}
                          </span>
                        ) : (
                          <span className="flex-1 text-[10px] text-amber-600 dark:text-amber-400">
                            Este repo no tiene rama <span className="font-mono">{destinos[0]}</span>, que es
                            el único destino válido desde <span className="font-mono">{newPR.head}</span>.
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {/* dev→main: qué contiene este release (PRs a dev + commits) */}
                  {newPR.head === "dev" && newPR.base === "main" && (
                    <div className="rounded border bg-muted/30 px-2 py-1.5">
                      <p className="mb-1 text-[10px] font-semibold text-muted-foreground">
                        Este PR a main incluye:
                      </p>
                      {newPR.releasePRs == null ? (
                        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> cargando contenido del release…
                        </p>
                      ) : newPR.releasePRs.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground italic">Sin PRs nuevos respecto a main.</p>
                      ) : (
                        <ul className="max-h-36 space-y-1 overflow-y-auto">
                          {newPR.releasePRs.map((pr) => {
                            const isOther = !canViewOthers && pr.author !== selfLogin;
                            if (isOther) {
                              return (
                                <li key={pr.number} className="text-[11px] italic text-muted-foreground">
                                  <span className="font-medium not-italic">#{pr.number}</span> — cambios de otro usuario
                                </li>
                              );
                            }
                            const open = expandedReleasePRs.has(pr.number);
                            return (
                              <li key={pr.number} className="text-[11px]">
                                <button
                                  type="button"
                                  className="flex w-full items-start gap-1 text-left"
                                  onClick={() =>
                                    setExpandedReleasePRs((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(pr.number)) next.delete(pr.number); else next.add(pr.number);
                                      return next;
                                    })
                                  }
                                >
                                  {open ? <ChevronUp className="mt-0.5 h-3 w-3 shrink-0" /> : <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />}
                                  <span className="min-w-0 flex-1">
                                    <span className="font-medium text-violet-700 dark:text-violet-300">#{pr.number}</span>{" "}
                                    <span className="text-foreground">{pr.title}</span>{" "}
                                    <span className="text-[10px] text-muted-foreground">@{pr.author} · {pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"}</span>
                                  </span>
                                </button>
                                {open && (
                                  <ul className="ml-4 mt-0.5 space-y-0.5">
                                    {pr.commits.map((c) => (
                                      <li key={c.sha} className="flex items-start gap-1 text-[10px] text-muted-foreground">
                                        <span className="font-mono shrink-0">{c.sha}</span>
                                        <span className="truncate">{c.message}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                  <textarea
                    value={newPR.body}
                    onChange={(e) => setNewPR((p) => p ? { ...p, body: e.target.value } : null)}
                    placeholder="Descripción (obligatoria): qué cambia y por qué"
                    className={cn(
                      "w-full text-xs rounded border bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-violet-400 placeholder:text-muted-foreground",
                      newPR.head === "dev" && newPR.base === "main" ? "h-28" : "h-14",
                    )}
                  />
                  {/* Por qué el botón está gris, ESCRITO. El único indicio era
                      la palabra "obligatoria" en el placeholder —que desaparece
                      en cuanto se escribe una letra y vuelve a estar vacío si se
                      borra—, así que un botón muerto sin explicación parecía un
                      permiso que falta o algo roto. La descripción es
                      obligatoria porque de ahí sale el cuerpo del release
                      dev→main y el aviso de WhatsApp: sin ella, el resumen del
                      release dice "(sin descripcion)" y nadie sabe qué entró. */}
                  {(() => {
                    const falta =
                      !newPR.title.trim() ? "Falta el título." :
                      !newPR.body.trim() ? "Falta la descripción: se usa en el resumen del release y en el aviso." :
                      !status.branches.some((b) => b.name === newPR.base)
                        ? `Este repo no tiene la rama ${newPR.base}.` : null;
                    return falta ? (
                      <p className="text-[10px] text-muted-foreground">{falta}</p>
                    ) : null;
                  })()}
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreatePR}
                      title={
                        !newPR.title.trim() ? "Falta el título" :
                        !newPR.body.trim() ? "Falta la descripción (obligatoria)" :
                        !status.branches.some((b) => b.name === newPR.base)
                          ? `Este repo no tiene la rama ${newPR.base}` :
                        `Crear el PR de ${newPR.head} hacia ${newPR.base}`
                      }
                      // Sin la rama destino en el repo, crear el PR es un 422 de
                      // GitHub: mejor no ofrecerlo que explicar después por qué
                      // falló.
                      disabled={
                        newPRLoading
                        || !newPR.title.trim()
                        || !newPR.body.trim()
                        || !status.branches.some((b) => b.name === newPR.base)
                      }
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
                    >
                      {newPRLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitPullRequest className="h-3 w-3" />}
                      Crear PR
                    </button>
                    <button
                      onClick={closeCreatePR}
                      disabled={newPRLoading}
                      className="px-3 text-xs text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-muted transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* PRs abiertos */}
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            <GitPullRequest className="h-3.5 w-3.5" /> PRs abiertos ({scopedPRs.length})
          </h4>
          <PRList prs={scopedPRs} owner={status.owner} repo={status.repo} onRefetch={onRefetch} perms={perms} approver={approver} codeOwnerAuths={codeOwnerAuths} selfLogin={canViewOthers ? null : selfLogin} avisos={avisos} />
        </div>

        {/* Últimos deploys */}
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            <Zap className="h-3.5 w-3.5" /> Últimos deploys
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {status.latestRuns.length === 0
              ? <p className="text-xs text-muted-foreground">Sin deploys recientes</p>
              : status.latestRuns.map((r, i) => (
                  <DeployMetaTooltip key={i} owner={status.owner} repo={status.repo} run={r} avisos={avisos}>
                    <WorkflowBadge run={r} owner={status.owner} repo={status.repo} selfLogin={canViewOthers ? null : selfLogin} />
                  </DeployMetaTooltip>
                ))}
          </div>
          {/* Del último terminado, a quién se le avisó. Solo del último: una
              línea por cada deploy de la lista sería ruido, y el resto sigue
              disponible en el tooltip de su badge. */}
          {ultimoTerminado && !isDeployingToMain && (
            <div className="mt-1.5">
              <AvisoDeploy owner={status.owner} repo={status.repo} run={ultimoTerminado} avisos={avisos} conEtiquetaDelRun />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function RepoCardSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
          <div className="h-5 bg-muted rounded w-40 animate-pulse" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-4 bg-muted rounded animate-pulse" />)}
        </div>
      </CardContent>
    </Card>
  );
}
