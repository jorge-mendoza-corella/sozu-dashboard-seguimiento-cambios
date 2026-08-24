import { useEffect, useState } from "react";
import { MessageCircle, MessageCircleOff, AlertTriangle, Loader2 } from "lucide-react";
import { getDeployNotification, type DeployNotification } from "@/lib/deployNotifications";
import { getDeployMetaCached, metaEnCache } from "@/lib/deployMetaCache";
import { useAuth } from "@/hooks/useAuth";
import { useDirectorio, type AvisosDelProyecto } from "@/hooks/useAvisos";
import { Avisado, type Papel } from "./Avisado";
import { formatDistanceToNow } from "@/lib/timeUtils";
import type { DeployMeta, WorkflowRun } from "@/lib/github";

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

export function AvisoDeploy({ owner, repo, run, avisos, sobreFondoOscuro = false, conEtiquetaDelRun = false }: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  avisos?: AvisosDelProyecto;
  /** En el banner verde de "deploy en progreso" el texto va en blanco. */
  sobreFondoOscuro?: boolean;
  /**
   * Decir DE QUÉ deploy se habla. Al pie de la lista de deploys la línea se leía
   * como una propiedad de la tarjeta —o del deploy que está corriendo—, cuando
   * es del último que terminó: hay tres chips arriba y ninguna pista de a cuál
   * corresponde. En el banner del deploy en curso no hace falta: el banner ya
   * dice cuál es.
   */
  conEtiquetaDelRun?: boolean;
}) {
  const clave = run.runId ? `${owner}/${repo}#${run.runId}` : null;
  const corriendo = run.status !== "completed";
  // Solo para re-renderizar cuando la lectura termina; el valor sale de la
  // caché, que es la fuente única. Guardarlo también en el estado obligaría a
  // sincronizar dos copias del mismo dato.
  const [, redibujar] = useState(0);
  const registro = clave && cache.has(clave) ? cache.get(clave) : undefined;
  // Autores, aprobadores y quién mergeó: es lo que convierte una lista de
  // logins en "a quién le llegó y por qué". Sale de la caché compartida con el
  // tooltip del badge, así que no cuesta una petición extra.
  const [meta, setMeta] = useState<DeployMeta | null>(metaEnCache(run.headSha) ?? null);
  const { appUser } = useAuth();
  const directorio = useDirectorio(appUser);

  useEffect(() => {
    if (!run.headSha || metaEnCache(run.headSha)) return;
    let vivo = true;
    getDeployMetaCached(owner, repo, run.headSha)
      .then((m) => { if (vivo) setMeta(m); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [owner, repo, run.headSha]);

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

  const metaResuelta = metaEnCache(run.headSha) ?? meta;
  /**
   * Qué fue cada quien en ESTE deploy. Una persona puede ser varias cosas —el
   * caso normal en un equipo chico es que el mismo login sea autor y quien
   * mergeó—, así que se acumulan en vez de elegir una.
   */
  const papelesDe = (login: string): Papel[] => {
    const p: Papel[] = [];
    if (login === run.actor) p.push("disparo");
    if (metaResuelta?.authors.includes(login)) p.push("autor");
    if (metaResuelta?.approvedBy.some((a) => a.login === login)) p.push("aprobador");
    else if (avisos?.destinatarios.some((d) => d.login === login && d.motivo === "aprobador")) p.push("aprobador");
    if (metaResuelta?.mergedBy === login) p.push("mergeo");
    if (avisos?.destinatarios.some((d) => d.login === login && d.motivo === "suscrito")) p.push("suscrito");
    return p;
  };
  const persona = (login: string) => (
    <Avisado
      key={login}
      login={login}
      papeles={papelesDe(login)}
      ficha={directorio.get(login)}
      sobreFondoOscuro={sobreFondoOscuro}
    />
  );

  // "Dev · hace 23m", el mismo lenguaje de los chips de arriba, para que se vea
  // a qué deploy se refiere sin tener que deducirlo.
  const destino = run.headBranch === "main" ? "PRD" : "Dev";
  const etiqueta = conEtiquetaDelRun
    // Corriendo se dice "a PRD" —el deploy va hacia allá, no terminó— y ya
    // terminado, "PRD · hace 23m", que es lo que distingue un deploy de otro
    // en la lista.
    ? (corriendo ? `${destino}:` : `${destino} · ${formatDistanceToNow(run.createdAt)}:`)
    : null;

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
            <span>{etiqueta} no se avisó: {registro.motivo || "la empresa no tiene los avisos activos."}</span>
          </p>
        );
      }
      return (
        <div className="space-y-0.5">
          {registro.avisados.length > 0 && (
            <p className={`flex items-start gap-1 text-[11px] ${bien}`}>
              <MessageCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                {etiqueta && <span className="font-medium opacity-80">{etiqueta}</span>}
                avisó a
                {registro.avisados.map((l, i) => (
                  <span key={l} className="inline-flex items-center">
                    {persona(l)}{i < registro.avisados.length - 1 ? "," : ""}
                  </span>
                ))}
              </span>
            </p>
          )}
          {/* Quien NO recibió importa más que quien sí: nadie va a abrir el log
              del workflow para enterarse de que su aviso no salió. */}
          {registro.fallidos.map((f) => (
            <p key={f.login} className={`flex items-start gap-1 text-[11px] ${alerta}`}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{persona(f.login)} no recibió el aviso: {f.motivo}</span>
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
  // Quien disparó el deploy va primero y CON SU LOGIN: decía "quien lo disparó",
  // que obliga a ir al tooltip del badge para saber de quién se habla, justo
  // mientras uno mira correr la barra.
  const destinos = [
    ...(run.actor ? [run.actor] : []),
    ...avisos.destinatarios.filter((d) => d.tieneTelefono && d.login !== run.actor).map((d) => d.login),
  ];
  return (
    <p className={`flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] ${sobreFondoOscuro ? "text-white/90" : tenue}`}>
      <MessageCircle className="h-3 w-3 shrink-0" />
      {etiqueta && <span className="font-medium opacity-80">{etiqueta}</span>}
      {corriendo ? "al terminar avisará a" : "le tocaba avisar a"}
      {destinos.length === 0 ? (
        <span>quien lo disparó</span>
      ) : (
        destinos.map((l, i) => (
          <span key={l} className="inline-flex items-center">
            {persona(l)}{i < destinos.length - 1 ? "," : ""}
          </span>
        ))
      )}
      {!corriendo && <span className="opacity-70">(este deploy no dejó registro)</span>}
    </p>
  );
}
