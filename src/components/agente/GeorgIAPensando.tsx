/**
 * Pie de la lista de tickets: una viñeta de manga grande (solo el cuadro, no el
 * personaje completo) que va rotando entre los 5 estilos —zoom con líneas, ojos
 * dramáticos, gota de sudor, shoujo y shock— con dudas, ideas y barbaridades
 * sobre los tickets. Solo decorativa.
 */
import { useEffect, useState } from "react";
import { Personaje, type Animo } from "./AgenteVolador";
import "./personaje.css";

type Estilo = "zoom" | "ojos" | "gota" | "shoujo" | "shock";
const PENSAMIENTOS: { estilo: Estilo; animo: Animo; texto: string }[] = [
  { estilo: "zoom", animo: "grito", texto: "¡¿QUIÉN PIDIÓ ESTO PARA AYER?!" },
  { estilo: "ojos", animo: "aburrido", texto: "…¿alta prioridad? Aquí todo es alta, cabrón" },
  { estilo: "gota", animo: "serio", texto: "Se ve fácil… por eso me da miedo 💧" },
  { estilo: "shoujo", animo: "feliz", texto: "✨ Uno a la vez y sin llorar ✨" },
  { estilo: "shock", animo: "grito", texto: "¡¡ESTE HUELE A VIERNES 6 PM!!" },
  { estilo: "ojos", animo: "serio", texto: "…primero investigo, luego me quejo" },
  { estilo: "zoom", animo: "grito", texto: "¡¿Y SI ES UN BUG DISFRAZADO?!" },
  { estilo: "gota", animo: "aburrido", texto: "Ni Stack Overflow sabe de este 💧" },
  { estilo: "shoujo", animo: "relajado", texto: "✨ Respira… nadie se ha muerto por un ticket ✨" },
  { estilo: "shock", animo: "grito", texto: "¡¡PINCHE TICKET, ME ESTÁ VIENDO FEO!!" },
  { estilo: "ojos", animo: "aburrido", texto: "…sé que me estás ignorando, #1151" },
  { estilo: "gota", animo: "serio", texto: "¿Esto lo pidió negocio o fue un sueño? 💧" },
];
const SIN_TICKETS = { estilo: "shoujo" as Estilo, animo: "relajado" as Animo, texto: "✨ Cero tickets… ¿me puedo ir a mi casa? ✨" };

export function GeorgIAPensando({ pendientes }: { pendientes: number }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * PENSAMIENTOS.length));
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1 + Math.floor(Math.random() * 3)) % PENSAMIENTOS.length), 6500);
    return () => clearInterval(t);
  }, []);
  const p = pendientes === 0 ? SIN_TICKETS : PENSAMIENTOS[i];

  return (
    <div className="border-t p-2.5" aria-hidden>
      <div key={`${p.estilo}${p.texto}`} className="agente-manga agente-manga--estatica" data-estilo={p.estilo}>
        {p.estilo === "zoom" && <div className="agente-manga__lineas" />}
        {p.estilo === "shock" && <div className="agente-manga__rayo" />}
        {p.estilo === "shoujo" && (
          <div className="agente-manga__brillos">
            {["✨", "🌸", "✨", "🌸", "✨"].map((b, k) => <span key={k}>{b}</span>)}
          </div>
        )}
        <div className="agente-manga__cara">
          <Personaje pose="quieto" animo={p.animo} />
        </div>
        {p.estilo === "gota" && <span className="agente-manga__gota">💧</span>}
        <span className="agente-manga__texto">{p.texto}</span>
      </div>
    </div>
  );
}
