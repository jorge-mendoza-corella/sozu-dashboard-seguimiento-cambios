import { useEffect, useState } from "react";
import { MessageCircle, MessageCircleOff, AlertTriangle, Loader2 } from "lucide-react";
import { getDeployNotification, type DeployNotification } from "@/lib/deployNotifications";
import type { AvisosDelProyecto } from "@/hooks/useAvisos";
import type { WorkflowRun } from "@/lib/github";

// ---------------------------------------------------------------------------
// A quién se le avisa de un deploy, dicho EN LA TARJETA.
//
// Esto ya existía dentro del tooltip del badge, y ahí no servía: hay que
// atinarle con el puntero a un icono de 12px para enterarse de algo que se
// consulta justo cuando el deploy está corriendo y uno mira la pantalla sin
// tocar nada. Aquí se ve solo.
//
// Los dos momentos dicen cosas distintas a propósito:
//
//   · corriendo  → "avisará a …". El aviso sale al final del workflow, así que
//     hablar en pasado sería afirmar algo que todavía no pasó.
//   · terminado  → "avisó a …", y eso NO se calcula: se lee del registro que
//     dejó el propio deploy. El dashboard puede deducir a quién le toca, pero
//     no si el mensaje salió —un teléfono sin capturar, una instancia caída o
//     una empresa apagada cambian el resultado sin cambiar nada de lo que se ve
//     desde aquí—. Sin registro se dice en condicional y se admite que no lo
//     hay, en vez de inventar una entrega.
// ---------------------------------------------------------------------------

const cache = new Map<string, DeployNotification | null>();

export function AvisoDeploy({ owner, repo, run, avisos, sobreFondoOscuro = false }: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  avisos?: AvisosDelProyecto;
  /** En el banner verde de "deploy en progreso" el texto va en blanco. */
  sobreFondoOscuro?: boolean;
}) {
  const clave = run.runId ? `${owner}/${repo}#${run.runId}` : null;
  const corriendo = run.status !== "completed";
  // Solo para re-renderizar cuando la lectura termina; el valor sale de la
  // caché, que es la fuente única. Guardarlo también en el estado obligaría a
  // sincronizar dos copias del mismo dato.
  const [, redibujar] = useState(0);
  const registro = clave && cache.has(clave) ? cache.get(clave) : undefined;

  useEffect(() => {
    // Un deploy en curso todavía no escribió nada: preguntarlo sería una lectura
    // segura de que no hay nada. Se consulta al terminar.
    if (!clave || !run.runId || corriendo || cache.has(clave)) return;
    let vivo = true;
    getDeployNotification(owner, repo, run.runId)
      .catch(() => null)
      .then((n) => {
        cache.set(clave, n);
        if (vivo) redibujar((v) => v + 1);
      });
    return () => { vivo = false; };
  }, [clave, owner, repo, run.runId, corriendo]);

  const tenue = sobreFondoOscuro ? "text-white/80" : "text-muted-foreground";
  const alerta = sobreFondoOscuro ? "text-amber-100" : "text-amber-600 dark:text-amber-400";
  const bien = sobreFondoOscuro ? "text-emerald-50" : "text-emerald-600 dark:text-emerald-400";

  // --- Deploy terminado: lo que el CI dejó anotado --------------------------
  if (!corriendo) {
    if (registro === undefined) {
      return (
        <p className={`flex items-center gap-1 text-[11px] ${tenue}`}>
          <Loader2 className="h-3 w-3 animate-spin" /> viendo a quién se avisó…
        </p>
      );
    }
    if (registro) {
      if (!registro.seMando) {
        return (
          <p className={`flex items-start gap-1 text-[11px] ${alerta}`}>
            <MessageCircleOff className="mt-0.5 h-3 w-3 shrink-0" />
            <span>No se avisó: {registro.motivo || "la empresa no tiene los avisos activos."}</span>
          </p>
        );
      }
      return (
        <div className="space-y-0.5">
          {registro.avisados.length > 0 && (
            <p className={`flex items-start gap-1 text-[11px] ${bien}`}>
              <MessageCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Avisó a <span className="font-mono">{registro.avisados.map((l) => `@${l}`).join(", ")}</span>
              </span>
            </p>
          )}
          {/* Quien NO recibió importa más que quien sí: nadie va a abrir el log
              del workflow para enterarse de que su aviso no salió. */}
          {registro.fallidos.map((f) => (
            <p key={f.login} className={`flex items-start gap-1 text-[11px] ${alerta}`}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span><span className="font-mono">@{f.login}</span> no recibió el aviso: {f.motivo}</span>
            </p>
          ))}
          {registro.avisados.length === 0 && registro.fallidos.length === 0 && (
            <p className={`flex items-start gap-1 text-[11px] ${tenue}`}>
              <MessageCircleOff className="mt-0.5 h-3 w-3 shrink-0" />
              <span>No hubo a quién avisar.</span>
            </p>
          )}
        </div>
      );
    }
  }

  // --- Corriendo, o terminado sin registro: se habla en futuro ---------------
  if (!avisos || avisos.desconocido) return null;
  if (!avisos.empresaAvisa) {
    return (
      <p className={`flex items-start gap-1 text-[11px] ${alerta}`}>
        <MessageCircleOff className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{corriendo ? "No se avisará" : "No se avisó"}: {avisos.motivoEmpresa}</span>
      </p>
    );
  }
  const fijos = avisos.destinatarios.filter((d) => d.tieneTelefono).map((d) => `@${d.login}`);
  return (
    <p className={`flex items-start gap-1 text-[11px] ${sobreFondoOscuro ? "text-white/90" : tenue}`}>
      <MessageCircle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        {corriendo ? "Al terminar avisará a" : "Le tocaba avisar a"}{" "}
        <span className="font-mono">{["quien lo disparó", ...fijos].join(", ")}</span>
        {!corriendo && " (este deploy no dejó registro)"}
      </span>
    </p>
  );
}
