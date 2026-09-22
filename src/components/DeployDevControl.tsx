import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getAutoDeployDev,
  setAutoDeployDev,
  dispararDeployDev,
  repoDespliegaDev,
  mismoCommit,
} from "@/lib/github";

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
  shaDev,
  shaPublicado,
  desplegando = false,
}: {
  owner: string;
  repo: string;
  /**
   * Permiso "Switch deploy a dev". Va aparte de `mergeDev` porque son
   * decisiones distintas: una es "este cambio entra", la otra es "el entorno
   * que usa todo el mundo se publica ahora".
   */
  puedeTocar: boolean;
  /** Punta de la rama dev. */
  shaDev?: string;
  /** Lo último que se publicó en dev, si se publicó bien. */
  shaPublicado?: string;
  /**
   * Ya hay un deploy de dev en marcha.
   *
   * Pulsar entonces no adelanta nada: con la cola activa, el nuevo cancela al
   * que está corriendo y se empieza de cero. Sale más tarde que si se espera.
   */
  desplegando?: boolean;
}) {
  const qc = useQueryClient();
  const [guardando, setGuardando] = useState(false);
  const [lanzando, setLanzando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  // ¿Este repo despliega dev? Las apps, el dashboard y n8n solo publican main:
  // su dev acumula PRs y ya. Ahí el control prometía algo que no ocurre nunca, y
  // el botón devolvía un error al pulsarlo.
  const { data: tieneDeployDev } = useQuery({
    queryKey: ["repo-despliega-dev", owner, repo],
    queryFn: () => repoDespliegaDev(owner, repo),
    // Los workflows de un repo cambian cada varios meses; preguntarlo seguido
    // sería gastar rate limit para recibir siempre lo mismo.
    staleTime: 60 * 60_000,
  });

  const { data: automatico } = useQuery({
    queryKey: ["auto-deploy-dev", owner, repo],
    queryFn: () => getAutoDeployDev(owner, repo),
    // Sin deploy de dev no hay variable que consultar ni nada que enseñar.
    enabled: tieneDeployDev === true,
    staleTime: 5 * 60_000,
  });

  if (!puedeTocar || !tieneDeployDev || automatico === undefined) return null;

  // Sin los dos commits no se puede afirmar nada, y ante la duda es mejor
  // dejar el botón: lanzar de más molesta menos que no poder lanzar.
  const alDia = mismoCommit(shaDev, shaPublicado);

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
      {!automatico &&
        // Y solo si hay algo que publicar. Con dev ya desplegado —mismo commit
        // arriba que abajo— el botón invitaba a lanzar un deploy que reconstruye
        // y vuelve a subir exactamente lo mismo: minutos gastados para dejar el
        // entorno como estaba.
        (desplegando ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            desplegando dev…
          </span>
        ) : alDia ? (
          <span className="text-muted-foreground" title={`dev está publicado en su último commit (${shaDev?.slice(0, 7)}).`}>
            dev al día
          </span>
        ) : (
          <button
            type="button"
            onClick={lanzar}
            disabled={lanzando}
            className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
            title={
              shaDev
                ? `Publica dev en su commit actual (${shaDev.slice(0, 7)}).`
                : "Publica la rama dev tal y como está ahora."
            }
          >
            {lanzando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
            {lanzando ? "Lanzando…" : "Desplegar dev"}
          </button>
        ))}

      {aviso && <span className="w-full text-[11px] text-muted-foreground">{aviso}</span>}
    </div>
  );
}
