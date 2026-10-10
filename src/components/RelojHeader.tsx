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
    <svg viewBox="0 0 200 200" className="h-44 w-44" aria-hidden>
      <defs>
        <linearGradient id="reloj-bisel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d6d8de" />
        </linearGradient>
        <radialGradient id="reloj-cara" cx="0.5" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.85" stopColor="#f7f7f9" />
          <stop offset="1" stopColor="#ececf0" />
        </radialGradient>
        <filter id="reloj-sombra-manecilla" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" floodColor="#000" floodOpacity="0.28" />
        </filter>
      </defs>
      {/* Bisel y carátula */}
      <circle cx="100" cy="100" r="98" fill="url(#reloj-bisel)" />
      <circle cx="100" cy="100" r="91" fill="url(#reloj-cara)" stroke="#c7c9cf" strokeWidth="0.6" />
      {/* Marcas: minutos finas, horas más gruesas */}
      {Array.from({ length: 60 }, (_, i) => {
        const hora = i % 5 === 0;
        return (
          <line
            key={i}
            x1="100" y1={hora ? 14 : 15} x2="100" y2={hora ? 24 : 19.5}
            stroke={hora ? "#1c1c1e" : "#a1a1aa"}
            strokeWidth={hora ? 2.6 : 1}
            strokeLinecap="round"
            transform={`rotate(${i * 6} 100 100)`}
          />
        );
      })}
      {/* Números */}
      {[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n, i) => {
        const a = (i * 30 * Math.PI) / 180;
        return (
          <text
            key={n}
            x={100 + Math.sin(a) * 64}
            y={100 - Math.cos(a) * 64 + 7.5}
            textAnchor="middle"
            fontSize="21"
            fontWeight="500"
            fill="#1c1c1e"
            fontFamily="-apple-system, 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif"
          >
            {n}
          </text>
        );
      })}
      {/* Manecillas estilo macOS: tramo fino junto al centro y luego la hoja ancha */}
      <g filter="url(#reloj-sombra-manecilla)">
        <g transform={`rotate(${aHora} 100 100)`}>
          <line x1="100" y1="100" x2="100" y2="88" stroke="#1c1c1e" strokeWidth="3.2" strokeLinecap="round" />
          <line x1="100" y1="88" x2="100" y2="52" stroke="#1c1c1e" strokeWidth="7" strokeLinecap="round" />
        </g>
        <g transform={`rotate(${aMin} 100 100)`}>
          <line x1="100" y1="100" x2="100" y2="88" stroke="#1c1c1e" strokeWidth="3.2" strokeLinecap="round" />
          <line x1="100" y1="88" x2="100" y2="24" stroke="#1c1c1e" strokeWidth="7" strokeLinecap="round" />
        </g>
        <circle cx="100" cy="100" r="5.4" fill="#1c1c1e" />
        <g transform={`rotate(${aSeg} 100 100)`}>
          <line x1="100" y1="118" x2="100" y2="17" stroke="#ff9500" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="100" cy="100" r="3.6" fill="#ff9500" />
        </g>
        <circle cx="100" cy="100" r="1.5" fill="#fff" />
      </g>
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
            sideOffset={10}
            // Sin caja: el reloj flota solo, con su sombra, y la fecha abajo.
            className="reloj-flotante z-[70] flex flex-col items-center gap-2 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95"
          >
            {abierto && <RelojAnalogico />}
            <FechaLarga />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function FechaLarga() {
  const ahora = useAhora(60_000);
  const larga = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "full" }).format(ahora);
  // Solo la primera letra en mayúscula ("Viernes, 9 de octubre de 2026").
  const fecha = larga.charAt(0).toUpperCase() + larga.slice(1);
  return (
    <p className="rounded-full bg-background/90 px-3 py-1 text-xs font-semibold shadow-md ring-1 ring-black/5 backdrop-blur">
      {fecha}
    </p>
  );
}
