import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAutoDeployDev, setAutoDeployDev, dispararDeployDev } from "@/lib/github";

// ---------------------------------------------------------------------------
// Cuándo se despliega dev.
//
// Cada merge a dev lanzaba su deploy, y con varios PRs seguidos había que
// esperarlos todos para ver el último —que es el único que importa, porque
// contiene a los anteriores—. Con el interruptor apagado, los merges solo
// mergean, y el deploy sale cuando alguien lo pide.
//
// El estado vive en una variable del propio repositorio (`AUTO_DEPLOY_DEV`),
// que es lo que lee el workflow. No hay copia en Firestore: dos sitios con la
// misma verdad acaban discrepando, y el que manda es el que lee el CI.
// ---------------------------------------------------------------------------

export function DeployDevControl({
  owner,
  repo,
  puedeTocar,
}: {
  owner: string;
  repo: string;
  /** Quien no puede mergear a dev tampoco decide cuándo se despliega dev. */
  puedeTocar: boolean;
}) {
  const qc = useQueryClient();
  const [guardando, setGuardando] = useState(false);
  const [lanzando, setLanzando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const { data: automatico } = useQuery({
    queryKey: ["auto-deploy-dev", owner, repo],
    queryFn: () => getAutoDeployDev(owner, repo),
    staleTime: 5 * 60_000,
  });

  if (!puedeTocar || automatico === undefined) return null;

  const cambiar = async () => {
    setGuardando(true);
    setAviso(null);
    try {
      await setAutoDeployDev(owner, repo, !automatico);
      await qc.invalidateQueries({ queryKey: ["auto-deploy-dev", owner, repo] });
    } catch (e) {
      // El fallo típico es de permisos: cambiar variables pide administrar el
      // repo, y no todos los tokens lo tienen. Decirlo evita buscar en otro lado.
      setAviso(
        e instanceof Error && /403|not accessible|permission/i.test(e.message)
          ? "Tu token de GitHub no puede cambiar variables de este repo (hace falta administrarlo)."
          : "No se pudo guardar el cambio.",
      );
    } finally {
      setGuardando(false);
    }
  };

  const lanzar = async () => {
    setLanzando(true);
    setAviso(null);
    try {
      const nombre = await dispararDeployDev(owner, repo);
      setAviso(`Lanzado: ${nombre}. Tarda unos segundos en aparecer arriba.`);
    } catch (e) {
      setAviso(e instanceof Error ? e.message : "No se pudo lanzar el deploy.");
    } finally {
      setLanzando(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={cambiar}
        disabled={guardando}
        className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        title={
          automatico
            ? "Cada merge a dev despliega. Apágalo para mergear varios PRs sin esperar un deploy por cada uno."
            : "Los merges a dev no despliegan. Usa «Desplegar dev» cuando quieras publicar lo acumulado."
        }
      >
        {/* Interruptor propio y no un checkbox: dice su estado de un vistazo
            desde el otro lado de la mesa, que es como se mira esta pantalla. */}
        <span
          className={cn(
            "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
            automatico ? "bg-emerald-500" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
              automatico ? "translate-x-3.5" : "translate-x-0.5",
            )}
          />
        </span>
        {guardando ? "guardando…" : automatico ? "deploy automático a dev" : "deploy a dev manual"}
      </button>

      {/* El botón solo cuando hace falta: con el automático encendido, pulsarlo
          sería repetir lo que ya va a pasar solo. */}
      {!automatico && (
        <button
          type="button"
          onClick={lanzar}
          disabled={lanzando}
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {lanzando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
          {lanzando ? "Lanzando…" : "Desplegar dev"}
        </button>
      )}

      {aviso && <span className="w-full text-[11px] text-muted-foreground">{aviso}</span>}
    </div>
  );
}
