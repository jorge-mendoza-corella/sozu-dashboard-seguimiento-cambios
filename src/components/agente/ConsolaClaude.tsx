/**
 * Consola en vivo de Claude Code: lo que va haciendo en la corrida (comandos,
 * archivos, búsquedas, plan), en tiempo real (onSnapshot). La escribe la función
 * `agenteClaudeLog` desde un hook del orquestador; solo trae la última corrida.
 *
 * Se ve como ventana flotante (botón "Consola" junto a la barra de avance) que
 * se arrastra y cambia de tamaño. Va dentro del panel (no en un portal): el
 * diálogo de GeorgIA es modal y bloquea lo que quede fuera; y así, al cerrar el
 * detalle, la ventana se cierra con él.
 */
import { useEffect, useRef, useState, type PointerEvent as PE } from "react";
import { GripHorizontal, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Consola, LineaConsola } from "@/hooks/useConsolaClaude";

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

function EnVivo({ enVivo }: { enVivo: boolean }) {
  return enVivo ? (
    <span className="inline-flex items-center gap-1 text-emerald-400">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 motion-reduce:animate-none" /> en vivo
    </span>
  ) : (
    <span>última corrida</span>
  );
}

/** Las líneas, siguiendo el final como una terminal salvo que subas a leer. */
function Lineas({ lineas, enVivo, className }: { lineas: LineaConsola[]; enVivo: boolean; className?: string }) {
  const caja = useRef<HTMLDivElement>(null);
  const pegadaAbajo = useRef(true);
  useEffect(() => {
    const c = caja.current;
    if (c && pegadaAbajo.current) c.scrollTop = c.scrollHeight;
  }, [lineas]);
  return (
    <div
      ref={caja}
      onScroll={(e) => {
        const c = e.currentTarget;
        pegadaAbajo.current = c.scrollHeight - c.scrollTop - c.clientHeight < 24;
      }}
      className={cn("overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed", className)}
    >
      {lineas.length === 0 && <p className="text-zinc-500">Esperando la primera acción…</p>}
      {lineas.map((l, i) => (
        <p key={`${l.t}-${i}`} className="flex gap-2 whitespace-pre-wrap break-all">
          <span className="shrink-0 text-zinc-600">{hora(l.t)}</span>
          {l.repo && <span className="shrink-0 self-start rounded bg-zinc-800 px-1 text-[10px] font-semibold text-zinc-300">{l.repo}</span>}
          <span className={COLOR[l.tipo] ?? "text-zinc-300"}>{l.texto}</span>
        </p>
      ))}
      {enVivo && <span className="inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-zinc-300 motion-reduce:animate-none" />}
    </div>
  );
}

/** Ventana flotante: se arrastra por la barra de título y se redimensiona por la esquina. */
export function ConsolaFlotante({ consola, trabajando, titulo, onCerrar }: {
  consola: Consola;
  trabajando: boolean;
  titulo: string;
  onCerrar: () => void;
}) {
  const ANCHO = 560;
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1200) - ANCHO - 32),
    y: 72,
  }));
  const arrastre = useRef<{ dx: number; dy: number } | null>(null);

  const empezar = (e: PE<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    arrastre.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const mover = (e: PE<HTMLDivElement>) => {
    if (!arrastre.current) return;
    const x = Math.min(Math.max(0, e.clientX - arrastre.current.dx), window.innerWidth - 120);
    const y = Math.min(Math.max(0, e.clientY - arrastre.current.dy), window.innerHeight - 40);
    setPos({ x, y });
  };
  const soltar = () => { arrastre.current = null; };

  // Esc cierra solo la ventana (no el panel): se detiene antes que el diálogo.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCerrar();
      }
    };
    window.addEventListener("keydown", alTeclear, true);
    return () => window.removeEventListener("keydown", alTeclear, true);
  }, [onCerrar]);

  const enVivo = consola.activo || trabajando;
  return (
    <div
      className="fixed z-[70] flex min-h-[160px] min-w-[320px] resize flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 text-zinc-200 shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: ANCHO, height: 380, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)" }}
      role="dialog"
      aria-label="Consola de Claude"
    >
      <div
        onPointerDown={empezar}
        onPointerMove={mover}
        onPointerUp={soltar}
        onPointerCancel={soltar}
        className="flex cursor-grab touch-none select-none items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px] text-zinc-400 active:cursor-grabbing"
      >
        <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        <Terminal className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-medium text-zinc-300">Consola de Claude · {titulo}</span>
        <EnVivo enVivo={enVivo} />
        <span className="ml-auto shrink-0 tabular-nums">{consola.lineas.length} líneas</span>
        <button type="button" onClick={onCerrar} className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100" title="Cerrar ventana (Esc)">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Lineas lineas={consola.lineas} enVivo={enVivo} className="min-h-0 flex-1" />
    </div>
  );
}
