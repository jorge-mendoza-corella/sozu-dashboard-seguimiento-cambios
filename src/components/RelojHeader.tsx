/**
 * Reloj del header (junto al monitor de WhatsApp): fecha y hora corta. Al pasar
 * el mouse, un reloj de manecillas estilo macOS con la fecha completa abajo.
 * Hora de México, como el resto del dashboard.
 */
import { useEffect, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Clock } from "lucide-react";

const ZONA = "America/Mexico_City";

/** Hora/minuto/segundo en la zona del dashboard (no la del navegador). */
function partes(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: ZONA, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { h: Number(p.hour), m: Number(p.minute), s: Number(p.second) + d.getMilliseconds() / 1000 };
}

function useAhora(intervaloMs: number) {
  const [ahora, setAhora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAhora(new Date()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return ahora;
}

function RelojAnalogico() {
  // Con el tooltip abierto, ~30 fps para que el segundero barra suave como en macOS.
  const ahora = useAhora(33);
  const { h, m, s } = partes(ahora);
  const aHora = ((h % 12) + m / 60) * 30;
  const aMin = (m + s / 60) * 6;
  const aSeg = s * 6;
  return (
    <svg viewBox="0 0 100 100" className="h-32 w-32" aria-hidden>
      <defs>
        <radialGradient id="reloj-cara" cx="0.5" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef0f3" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="#1f2937" />
      <circle cx="50" cy="50" r="45.5" fill="url(#reloj-cara)" />
      {Array.from({ length: 60 }, (_, i) => (
        <line
          key={i}
          x1="50" y1={i % 5 === 0 ? 7.5 : 8.5} x2="50" y2={i % 5 === 0 ? 13 : 10.5}
          stroke={i % 5 === 0 ? "#111827" : "#9ca3af"}
          strokeWidth={i % 5 === 0 ? 1.6 : 0.6}
          strokeLinecap="round"
          transform={`rotate(${i * 6} 50 50)`}
        />
      ))}
      {[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n, i) => {
        const a = (i * 30 * Math.PI) / 180;
        return (
          <text key={n} x={50 + Math.sin(a) * 31} y={50 - Math.cos(a) * 31 + 3.6} textAnchor="middle" fontSize="10" fontWeight="500" fill="#111827" fontFamily="-apple-system, system-ui, sans-serif">
            {n}
          </text>
        );
      })}
      <line x1="50" y1="54" x2="50" y2="27" stroke="#111827" strokeWidth="3.4" strokeLinecap="round" transform={`rotate(${aHora} 50 50)`} />
      <line x1="50" y1="55" x2="50" y2="15" stroke="#111827" strokeWidth="2.2" strokeLinecap="round" transform={`rotate(${aMin} 50 50)`} />
      <g transform={`rotate(${aSeg} 50 50)`}>
        <line x1="50" y1="59" x2="50" y2="11" stroke="#f97316" strokeWidth="0.9" strokeLinecap="round" />
        <circle cx="50" cy="50" r="2" fill="#f97316" />
      </g>
      <circle cx="50" cy="50" r="0.9" fill="#fff" />
    </svg>
  );
}

export function RelojHeader() {
  const ahora = useAhora(10_000);
  const [abierto, setAbierto] = useState(false);
  const corta = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(ahora);
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root open={abierto} onOpenChange={setAbierto}>
        <Tooltip.Trigger asChild>
          <span
            tabIndex={0}
            className="hidden cursor-default items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground sm:inline-flex"
          >
            <Clock className="h-3 w-3" />
            {corta}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={8}
            className="z-[70] flex flex-col items-center gap-2 rounded-2xl border bg-background/95 px-5 py-4 shadow-xl backdrop-blur data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95"
          >
            {abierto && <RelojAnalogico />}
            <FechaLarga />
            <Tooltip.Arrow className="fill-background" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function FechaLarga() {
  const ahora = useAhora(1000);
  const larga = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "full" }).format(ahora);
  // Solo la primera letra en mayúscula ("Viernes, 9 de octubre de 2026").
  const fecha = larga.charAt(0).toUpperCase() + larga.slice(1);
  const hora = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(ahora);
  return (
    <div className="text-center">
      <p className="text-sm font-semibold">{fecha}</p>
      <p className="text-xs tabular-nums text-muted-foreground">{hora} · hora de México</p>
    </div>
  );
}
