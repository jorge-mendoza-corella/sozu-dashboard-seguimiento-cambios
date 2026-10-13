/**
 * Consola en vivo de Claude Code: lo que va haciendo en la corrida (comandos,
 * archivos, búsquedas, plan), en tiempo real (onSnapshot). La escribe la función
 * `agenteClaudeLog` desde un hook del orquestador; solo trae la última corrida.
 */
import { useEffect, useRef, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { ChevronDown, Terminal } from "lucide-react";
import { db } from "@/lib/firebase";
import { cn } from "@/lib/utils";

interface Linea {
  t: number;
  tipo: string;
  texto: string;
}

const COLOR: Record<string, string> = {
  bash: "text-emerald-300",
  leer: "text-sky-300",
  editar: "text-amber-300",
  buscar: "text-violet-300",
  plan: "text-fuchsia-300",
  web: "text-cyan-300",
  github: "text-zinc-300",
  fin: "text-emerald-400 font-semibold",
  paso: "text-zinc-400",
};

const hora = (t: number) => new Date(t).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ConsolaClaude({ issue, trabajando }: { issue: number; trabajando: boolean }) {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [activo, setActivo] = useState(false);
  const [abierta, setAbierta] = useState(true);
  const caja = useRef<HTMLDivElement>(null);
  const pegadaAbajo = useRef(true);

  useEffect(
    () =>
      onSnapshot(
        doc(db, "agente_claude_log", String(issue)),
        (snap) => {
          const d = snap.data();
          setLineas(Array.isArray(d?.lineas) ? (d.lineas as Linea[]) : []);
          setActivo(d?.activo === true);
        },
        () => setLineas([]),
      ),
    [issue],
  );

  // Sigue al final como una terminal, salvo que hayas subido a leer algo.
  useEffect(() => {
    const c = caja.current;
    if (c && pegadaAbajo.current) c.scrollTop = c.scrollHeight;
  }, [lineas, abierta]);

  if (!lineas.length && !trabajando) return null;
  const enVivo = activo || trabajando;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200 shadow-inner">
      <button
        type="button"
        onClick={() => setAbierta((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-900"
      >
        <Terminal className="h-3.5 w-3.5" />
        <span className="font-medium text-zinc-300">Consola de Claude</span>
        {enVivo ? (
          <span className="inline-flex items-center gap-1 text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 motion-reduce:animate-none" /> en vivo
          </span>
        ) : (
          <span>última corrida</span>
        )}
        <span className="ml-auto tabular-nums">{lineas.length} líneas</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", !abierta && "-rotate-90")} />
      </button>
      {abierta && (
        <div
          ref={caja}
          onScroll={(e) => {
            const c = e.currentTarget;
            pegadaAbajo.current = c.scrollHeight - c.scrollTop - c.clientHeight < 24;
          }}
          className="max-h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
        >
          {lineas.length === 0 && <p className="text-zinc-500">Esperando la primera acción…</p>}
          {lineas.map((l, i) => (
            <p key={`${l.t}-${i}`} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="shrink-0 text-zinc-600">{hora(l.t)}</span>
              <span className={COLOR[l.tipo] ?? "text-zinc-300"}>{l.texto}</span>
            </p>
          ))}
          {enVivo && <span className="inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-zinc-300 motion-reduce:animate-none" />}
        </div>
      )}
    </div>
  );
}
