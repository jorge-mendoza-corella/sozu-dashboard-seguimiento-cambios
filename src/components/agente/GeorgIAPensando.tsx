/**
 * GeorgIA al pie de la lista de tickets: pensativa (puño en la barbilla), con
 * nube de pensamiento que cambia cada pocos segundos — dudas, ideas y alguna
 * barbaridad. Solo decorativo: no interrumpe ni tapa nada.
 */
import { useEffect, useState } from "react";
import { Personaje, type Animo } from "./AgenteVolador";
import "./personaje.css";

const PENSAMIENTOS: { animo: Animo; texto: string }[] = [
  { animo: "serio", texto: "Hmm… ¿por cuál empiezo?" },
  { animo: "aburrido", texto: "¿Alta prioridad? Aquí todo es alta prioridad, cabrón" },
  { animo: "serio", texto: "Este ticket huele a viernes 6 pm…" },
  { animo: "feliz", texto: "¡Ya sé! …no, se me olvidó" },
  { animo: "serio", texto: "¿Y si es un bug disfrazado de feature?" },
  { animo: "aburrido", texto: "Ni Stack Overflow sabe de este" },
  { animo: "grito", texto: "¡¿Quién pidió esto para AYER?!" },
  { animo: "serio", texto: "Se ve fácil… por eso me da miedo" },
  { animo: "feliz", texto: "Uno a la vez y sin llorar" },
  { animo: "aburrido", texto: "Pinche ticket, me está viendo feo" },
  { animo: "serio", texto: "Primero investigo, luego me quejo" },
  { animo: "relajado", texto: "Respira… nadie se ha muerto por un ticket. Creo." },
];

export function GeorgIAPensando({ pendientes }: { pendientes: number }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * PENSAMIENTOS.length));
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1 + Math.floor(Math.random() * 3)) % PENSAMIENTOS.length), 6500);
    return () => clearInterval(t);
  }, []);
  const p = pendientes === 0 ? { animo: "relajado" as Animo, texto: "Cero tickets… ¿me puedo ir a mi casa?" } : PENSAMIENTOS[i];

  return (
    <div className="georgia-pensando flex items-end gap-1 border-t px-2 pb-1 pt-2" aria-hidden>
      <div className="h-[76px] w-[76px] shrink-0">
        <Personaje pose="quieto" animo={p.animo} />
      </div>
      <div key={p.texto} className="georgia-pensando__nube mb-9 flex-1 rounded-2xl border bg-background px-2.5 py-1.5 text-[11px] font-medium leading-snug text-muted-foreground shadow-sm">
        {p.texto}
      </div>
    </div>
  );
}
