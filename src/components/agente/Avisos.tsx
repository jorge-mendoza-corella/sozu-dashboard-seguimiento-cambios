/**
 * Pestaña «Avisos» del panel de GeorgIA (antes Megáfono): conversaciones 1 a 1.
 * Quien tiene el permiso abre una con una o varias personas (a cada una le
 * llega por su lado); el avatar de quien manda entra a la pantalla del otro y lo
 * grita. Los dos pueden contestar (texto y/o audio) o dar la conversación por
 * terminada. Se ve a quién ya le llegó cada mensaje.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, CheckCheck, CircleSlash, Loader2, Megaphone, Mic, Plus, Send, Square, Trash2, Volume2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { mensajeDeError } from "@/lib/agenteRepos";
import {
  destinatariosAvisos, escucharMensajes, iniciarAviso, marcarEntregado, otroDe, responderAviso, terminarAviso,
  type Conversacion, type MensajeAviso,
} from "@/lib/avisos";
import { meToca } from "@/hooks/useAvisosGeorgia";
import { useSkinGeorgIA } from "./skinsDatos";

const MAX_TEXTO = 500;
const MAX_SEG = 30;

const aDataUrl = (b: Blob) =>
  new Promise<string>((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => mal(r.error);
    r.readAsDataURL(b);
  });

const hora = (d: Date | null) =>
  d ? d.toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "ahora";

/** Texto, audio y «en voz alta»; lo usan el aviso nuevo y las respuestas. */
function Redactor({ onMandar, boton, placeholder, listoExtra = true }: {
  onMandar: (c: { texto: string; audio?: string; voz: boolean }) => Promise<void>;
  boton: string;
  placeholder: string;
  listoExtra?: boolean;
}) {
  const [texto, setTexto] = useState("");
  const [audio, setAudio] = useState<string | null>(null);
  const [enVoz, setEnVoz] = useState(true);
  const [grabando, setGrabando] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grabadora = useRef<MediaRecorder | null>(null);
  const reloj = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => {
    clearInterval(reloj.current);
    grabadora.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const detener = () => {
    clearInterval(reloj.current);
    if (grabadora.current?.state === "recording") grabadora.current.stop();
  };

  const grabar = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tipo = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
      // 32 kbps: 30 s caben de sobra en el mensaje.
      const rec = new MediaRecorder(stream, { ...(tipo ? { mimeType: tipo } : {}), audioBitsPerSecond: 32_000 });
      const partes: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && partes.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setGrabando(0);
        const blob = new Blob(partes, { type: rec.mimeType || "audio/webm" });
        if (blob.size) setAudio(await aDataUrl(blob));
      };
      grabadora.current = rec;
      rec.start();
      setGrabando(1);
      reloj.current = setInterval(() => {
        setGrabando((s) => {
          if (s >= MAX_SEG) detener();
          return s + 1;
        });
      }, 1000);
    } catch {
      setError("No se pudo usar el micrófono: revisa el permiso del navegador.");
    }
  };

  const listo = (texto.trim() || audio) && listoExtra && !grabando && !enviando;
  const mandar = async () => {
    setEnviando(true);
    setError(null);
    try {
      await onMandar({ texto: texto.trim(), audio: audio ?? undefined, voz: enVoz && !audio });
      setTexto("");
      setAudio(null);
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value.slice(0, MAX_TEXTO))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && listo) {
            e.preventDefault();
            void mandar();
          }
        }}
        rows={2}
        placeholder={placeholder}
        className="w-full resize-y rounded-lg border bg-background p-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {grabando ? (
          <button type="button" onClick={detener} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-semibold text-white">
            <Square className="h-3.5 w-3.5" /> Detener ({grabando - 1}s / {MAX_SEG}s)
          </button>
        ) : (
          <button type="button" onClick={() => void grabar()} className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted">
            <Mic className="h-3.5 w-3.5" /> {audio ? "Grabar otro" : "Audio"}
          </button>
        )}
        {audio && !grabando && (
          <>
            <audio src={audio} controls className="h-8" />
            <button type="button" onClick={() => setAudio(null)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Quitar el audio">
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
        <label className={cn("inline-flex items-center gap-1.5 text-xs", audio ? "text-muted-foreground/60" : "cursor-pointer")} title={audio ? "Con audio suena tu grabación" : undefined}>
          <input type="checkbox" checked={enVoz && !audio} disabled={!!audio} onChange={(e) => setEnVoz(e.target.checked)} className="accent-primary" />
          <Volume2 className="h-3.5 w-3.5" /> En voz alta
        </label>
        <span className="text-[11px] text-muted-foreground">{texto.length}/{MAX_TEXTO}</span>
        <button
          type="button"
          onClick={() => void mandar()}
          disabled={!listo}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {enviando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} {boton}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Cómo va el último mensaje: le toca a quién, ya le llegó o terminó. */
function Estado({ c, yo }: { c: Conversacion; yo: string }) {
  if (c.cerrada) {
    return <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"><CircleSlash className="h-2.5 w-2.5" /> Terminada</span>;
  }
  if (meToca(c, yo)) {
    return <span className="animate-pulse rounded bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-400 motion-reduce:animate-none dark:bg-amber-950/40 dark:text-amber-300">Te toca</span>;
  }
  return c.entregadoId === c.ultimo.id ? (
    <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" title={`Le llegó ${hora(c.entregadoEn)}`}>
      <CheckCheck className="h-3 w-3" /> Avisado
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300" title="Todavía no tiene el dashboard abierto: le llega en cuanto lo abra">
      <Check className="h-3 w-3" /> Por avisar
    </span>
  );
}

function NuevoAviso({ yo, onListo }: { yo: string; onListo: () => void }) {
  const skin = useSkinGeorgIA();
  const { data: gente, isLoading, error } = useQuery({ queryKey: ["avisos-destinatarios"], queryFn: destinatariosAvisos, staleTime: 5 * 60_000 });
  const [todos, setTodos] = useState(false);
  const [para, setPara] = useState<Set<string>>(new Set());
  const alternar = (e: string) =>
    setPara((xs) => {
      const n = new Set(xs);
      if (n.has(e)) n.delete(e);
      else n.add(e);
      return n;
    });
  const destinos = todos ? ["todos"] : [...para];
  return (
    <div className="p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Megaphone className="h-4 w-4" /> Nuevo aviso</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Tu avatar entra a la pantalla de cada quien y le grita el mensaje. Cada persona lo recibe en su propia conversación y te puede contestar.
      </p>
      <p className="mt-3 text-xs font-medium">¿A quién?</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setTodos((v) => !v)}
          className={cn("rounded-full border px-2.5 py-1 text-xs", todos ? "border-primary bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted")}
        >
          Todos
        </button>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {(gente ?? []).map((g) => {
          const on = !todos && para.has(g.email);
          return (
            <button
              key={g.email}
              type="button"
              onClick={() => { setTodos(false); alternar(g.email); }}
              title={g.email}
              className={cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-primary bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted")}
            >
              {g.nombre}{g.email === yo ? " (tú)" : ""}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{mensajeDeError(error)}</p>}
      <div className="mt-3">
        <Redactor
          boton="Mandar"
          placeholder="¡Ya salió el release! 🎉"
          listoExtra={destinos.length > 0}
          onMandar={async (c) => {
            await iniciarAviso(destinos, { ...c, skin });
            onListo();
          }}
        />
      </div>
    </div>
  );
}

/**
 * Una conversación. `compacto`: la ventanita que se abre junto al avatar que
 * trajo el aviso (se cierra con `onCerrar`, también al contestar).
 */
export function Hilo({ c, yo, compacto = false, onCerrar }: { c: Conversacion; yo: string; compacto?: boolean; onCerrar?: () => void }) {
  const skin = useSkinGeorgIA();
  const [mensajes, setMensajes] = useState<MensajeAviso[] | null>(null);
  const [terminando, setTerminando] = useState(false);
  const fin = useRef<HTMLDivElement>(null);
  const otro = otroDe(c, yo);
  useEffect(() => escucharMensajes(c.id, setMensajes), [c.id]);
  useEffect(() => { fin.current?.scrollIntoView({ block: "nearest" }); }, [mensajes?.length]);
  // Verlo aquí cuenta como entregado.
  useEffect(() => {
    if (meToca(c, yo) && c.ultimo.id && c.entregadoId !== c.ultimo.id) void marcarEntregado(c.id, c.ultimo.id).catch(() => {});
  }, [c, yo]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex items-center gap-2 border-b py-2.5", compacto ? "px-3" : "px-4")}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{compacto ? `Aviso · ${otro.nombre}` : otro.nombre}</p>
          <p className="text-[11px] text-muted-foreground">Inició {c.de === yo ? "tú" : c.deNombre} · {hora(c.creadoEn)}</p>
        </div>
        <Estado c={c} yo={yo} />
        {!c.cerrada && (
          <button
            type="button"
            disabled={terminando}
            onClick={async () => {
              setTerminando(true);
              await terminarAviso(c.id).catch(() => {});
              setTerminando(false);
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Ya no se le vuelve a aparecer a ninguno de los dos"
          >
            {terminando ? <Loader2 className="h-3 w-3 animate-spin" /> : <CircleSlash className="h-3 w-3" />} {compacto ? "Terminar" : "Terminar conversación"}
          </button>
        )}
        {onCerrar && (
          <button type="button" onClick={onCerrar} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Cerrar">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className={cn("min-h-0 space-y-2 overflow-y-auto bg-muted/20 py-3", compacto ? "max-h-60 px-3" : "flex-1 px-4")}>
        {!mensajes && <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />}
        {mensajes?.map((m) => {
          const mio = m.de === yo;
          const esUltimo = m.id === c.ultimo.id;
          return (
            <div key={m.id} className={cn("flex flex-col", mio ? "items-end" : "items-start")}>
              <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", mio ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border bg-background")}>
                <p className={cn("text-[10px] font-semibold", mio ? "text-primary-foreground/80" : "text-muted-foreground")}>
                  {mio ? "Tú" : m.deNombre}{m.voz && " · 🔊"}
                </p>
                {m.texto && <p className="whitespace-pre-wrap break-words">{m.texto}</p>}
                {m.audio && <audio src={m.audio} controls preload="metadata" className="mt-1 h-8 max-w-full" />}
              </div>
              <span className="mt-0.5 text-[10px] text-muted-foreground">
                {hora(m.creadoEn)}
                {mio && esUltimo && !c.cerrada && (c.entregadoId === m.id ? ` · ✓✓ le llegó ${hora(c.entregadoEn)}` : " · ✓ todavía no le llega")}
              </span>
            </div>
          );
        })}
        {c.cerrada && (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            {c.cerradaPor === yo ? "Terminaste" : `${otro.nombre} terminó`} la conversación.
          </p>
        )}
        <div ref={fin} />
      </div>
      {!c.cerrada && (
        <div className="border-t p-3">
          <Redactor
            boton="Contestar"
            placeholder={`Contéstale a ${otro.nombre}…`}
            onMandar={async (m) => {
              await responderAviso(c.id, { ...m, skin });
              // En la ventanita, contestar la cierra: tu avatar se lo lleva.
              if (compacto) onCerrar?.();
            }}
          />
        </div>
      )}
    </div>
  );
}

export function Avisos({ email, puedeIniciar, conversaciones, abrirId, onAbierto }: {
  email: string;
  puedeIniciar: boolean;
  conversaciones: Conversacion[];
  /** Conversación a abrir (clic en el avatar que trajo el aviso). */
  abrirId: string | null;
  onAbierto: () => void;
}) {
  const [elegida, setElegida] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [verTerminadas, setVerTerminadas] = useState(false);

  // Lo que pide el avatar manda sobre lo elegido a mano.
  const [ultimaPedida, setUltimaPedida] = useState<string | null>(null);
  if (abrirId && abrirId !== ultimaPedida) {
    setUltimaPedida(abrirId);
    setElegida(abrirId);
    setNuevo(false);
  }
  useEffect(() => { if (abrirId) onAbierto(); }, [abrirId, onAbierto]);

  // Agrupadas por envío: un aviso a varias personas se ve junto, con cómo va cada una.
  const grupos = useMemo(() => {
    const visibles = conversaciones.filter((c) => verTerminadas || !c.cerrada || c.id === elegida);
    const porLote = new Map<string, Conversacion[]>();
    for (const c of visibles) porLote.set(c.lote, [...(porLote.get(c.lote) ?? []), c]);
    return [...porLote.values()];
  }, [conversaciones, verTerminadas, elegida]);
  const terminadas = conversaciones.filter((c) => c.cerrada).length;
  const actual = conversaciones.find((c) => c.id === elegida) ?? null;
  const enDetalle = nuevo || !!actual;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className={cn("min-h-0 w-full flex-col border-r md:flex md:w-80 md:flex-none", enDetalle ? "hidden" : "flex")}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <h2 className="flex-1 text-sm font-semibold">Avisos</h2>
          {puedeIniciar && (
            <button
              type="button"
              onClick={() => { setNuevo(true); setElegida(null); }}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> Nuevo
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {grupos.length === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {puedeIniciar ? "Sin avisos. Manda uno con «Nuevo»." : "Aquí te llegan los avisos que te manden; los puedes contestar."}
            </p>
          )}
          {grupos.map((g) => {
            const c0 = g[0];
            // Varias personas en un mismo envío (solo lo ve quien lo mandó).
            if (g.length > 1) {
              return (
                <div key={c0.lote} className="rounded-md border p-2 text-xs">
                  <p className="truncate font-medium">«{c0.ultimo.de === email && c0.mensajes === 1 ? c0.ultimo.texto || "🔊 audio" : "Aviso a varios"}»</p>
                  <p className="text-[10px] text-muted-foreground">A {g.length} personas · {hora(c0.creadoEn)}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {g.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setElegida(c.id); setNuevo(false); }}
                        className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] hover:bg-muted", elegida === c.id && "border-primary")}
                      >
                        {c.paraNombre.split(" ")[0]} <Estado c={c} yo={email} />
                      </button>
                    ))}
                  </div>
                </div>
              );
            }
            const otro = otroDe(c0, email);
            return (
              <button
                key={c0.id}
                type="button"
                onClick={() => { setElegida(c0.id); setNuevo(false); }}
                className={cn("block w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors", elegida === c0.id ? "bg-primary/10" : "hover:bg-muted")}
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-semibold">{otro.nombre}</span>
                  <Estado c={c0} yo={email} />
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground">
                  {c0.ultimo.de === email ? "Tú: " : ""}{c0.ultimo.texto || "🔊 audio"}
                </span>
                <span className="block text-[10px] text-muted-foreground">{hora(c0.actualizadoEn)}</span>
              </button>
            );
          })}
        </div>
        {terminadas > 0 && (
          <button type="button" onClick={() => setVerTerminadas((v) => !v)} className="border-t px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground">
            {verTerminadas ? "Ocultar terminadas" : `Ver terminadas (${terminadas})`}
          </button>
        )}
      </aside>
      <section className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", enDetalle ? "flex" : "hidden")}>
        {enDetalle && (
          <button
            type="button"
            onClick={() => { setElegida(null); setNuevo(false); }}
            className="m-2 inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-sm font-medium text-primary hover:bg-primary/10 md:hidden"
          >
            <ArrowLeft className="h-4 w-4" /> Avisos
          </button>
        )}
        {nuevo && puedeIniciar ? (
          <NuevoAviso yo={email} onListo={() => setNuevo(false)} />
        ) : actual ? (
          <Hilo key={actual.id} c={actual} yo={email} />
        ) : (
          <p className="m-auto px-6 text-center text-sm text-muted-foreground">
            Elige una conversación{puedeIniciar ? " o manda un aviso nuevo" : ""}.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * Ventanita para contestar ahí mismo, junto al avatar que trajo el aviso (en
 * celular, abajo a todo lo ancho). Escape o la X la cierran.
 */
export function MiniAviso({ c, yo, donde, onCerrar, onVerTodo }: {
  c: Conversacion;
  yo: string;
  donde: DOMRect | null;
  onCerrar: () => void;
  onVerTodo: () => void;
}) {
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);
  const ancho = Math.min(360, window.innerWidth - 16);
  const celular = window.innerWidth < 640 || !donde;
  const estilo = celular
    ? { left: 8, right: 8, bottom: 8 }
    : {
        width: ancho,
        left: Math.min(Math.max(8, donde.left + donde.width / 2 - ancho / 2), window.innerWidth - ancho - 8),
        // Arriba del avatar (están en el piso).
        bottom: Math.max(8, window.innerHeight - donde.top + 10),
      };
  return createPortal(
    <div
      role="dialog"
      aria-label={`Aviso de ${otroDe(c, yo).nombre}`}
      className="fixed z-[45] flex max-h-[min(520px,calc(100vh-16px))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 duration-150"
      style={estilo}
    >
      <Hilo c={c} yo={yo} compacto onCerrar={onCerrar} />
      <button type="button" onClick={onVerTodo} className="border-t px-3 py-1.5 text-left text-[11px] text-primary hover:bg-muted">
        Ver en la pestaña Avisos →
      </button>
    </div>,
    document.body,
  );
}
