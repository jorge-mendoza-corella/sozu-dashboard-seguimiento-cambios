/**
 * Utilería de las escenas con guion de GeorgIA (AgenteVolador): viernes de
 * deploy (veladora a San Rollback), el elotero, la junta que pudo ser un
 * correo, Stack Overflow caído, el Wi-Fi de la oficina y el campamento con el
 * oso que se roba la cobija.
 *
 * La caja de cada escena va en un portal fijo, dibujada como si el personaje
 * mirara a la derecha y ocupara x 0-80 (se voltea entera si mira a la
 * izquierda; los textos se voltean de regreso). El que camina (elotero, oso)
 * es el "actor": va aparte y lo mueve el loop por `ref`, sin re-render.
 */
import type { Ref } from "react";
import { ANCHO_UTILERIA, type Utileria } from "./escenasDatos";

/** Pies del personaje dentro de la caja (30 arriba + 74 del sprite). */
const PISO = 104;

export function UtileriaEscena({ u, pausado, actorRef }: { u: Utileria; pausado: boolean; actorRef: Ref<HTMLDivElement> }) {
  const ancho = ANCHO_UTILERIA[u.tipo];
  return (
    <>
      <div
        key={u.id}
        className="agente-util"
        data-tipo={u.tipo}
        data-fase={u.fase}
        data-dir={u.dir}
        data-saliendo={u.saliendo || undefined}
        data-oculto={pausado || undefined}
        aria-hidden
        style={{ left: u.x, top: u.y, width: ancho }}
      >
        {u.tipo === "veladora" && <Veladora />}
        {(u.tipo === "junta" || u.tipo === "stack") && <MesaLaptop tipo={u.tipo} fase={u.fase} />}
        {u.tipo === "wifi" && <Wifi fase={u.fase} />}
        {u.tipo === "campamento" && <Campamento fase={u.fase} />}
      </div>
      {u.actor && (
        <div
          ref={actorRef}
          className="agente-actor"
          data-tipo={u.tipo}
          data-fase={u.fase}
          data-saliendo={u.saliendo || undefined}
          data-oculto={pausado || undefined}
          aria-hidden
          style={{ transform: `translate3d(${u.actor.x}px, ${u.actor.y}px, 0)` }}
        >
          <div className="agente-actor__cuerpo" style={{ transform: `scaleX(${u.actor.dir})` }}>
            {u.tipo === "elotero" ? <CarritoElotes /> : <Oso conCobija={u.fase === "huye" || u.fase === "cubrirse"} />}
          </div>
          {/* Fuera del cuerpo (que se voltea): así el letrero se lee en las dos direcciones. */}
          {u.tipo === "elotero" && <span className="agente-actor__letrero">ELOTES</span>}
          {u.tipo === "elotero" && u.fase === "llega" && <span className="agente-actor__grito">🎺 ¡Elotes, esquites!</span>}
        </div>
      )}
    </>
  );
}

/** Veladora a San Rollback, en el piso frente a él. */
function Veladora() {
  return (
    <>
      <svg viewBox={`0 0 130 ${PISO + 6}`} width="130" height={PISO + 6}>
        <ellipse className="agente-util__aura" cx="101" cy="80" rx="22" ry="22" fill="#fde68a" opacity="0.35" />
        <path className="agente-util__flama" d="M101 62 C97 68 97 72 101 74 C105 72 105 68 101 62 Z" fill="#f59e0b" />
        <path className="agente-util__flama" d="M101 66 C99.5 69 99.5 71 101 72 C102.5 71 102.5 69 101 66 Z" fill="#fef3c7" />
        <rect x="91" y="74" width="20" height="30" rx="2" fill="#fef9c3" stroke="#a16207" strokeWidth="1.2" opacity="0.95" />
        <rect x="93" y="80" width="16" height="16" rx="1" fill="#7c3aed" />
        <circle cx="101" cy="86" r="4" fill="#fde68a" />
        <path d="M95 96 h12" stroke="#fde68a" strokeWidth="1" />
      </svg>
      <span className="agente-util__texto agente-util__texto--veladora">SAN ROLLBACK</span>
    </>
  );
}

/** Mesita con laptop (de lado) y la pantalla en grande arriba: la junta o Stack Overflow. */
function MesaLaptop({ tipo, fase }: { tipo: "junta" | "stack"; fase: string }) {
  return (
    <>
      <svg viewBox={`0 0 170 ${PISO + 6}`} width="170" height={PISO + 6}>
        {/* Silla bajo el personaje */}
        <rect x="24" y="82" width="34" height="5" rx="2" fill="#78716c" />
        <path d="M28 87 L26 104 M54 87 L56 104" stroke="#57534e" strokeWidth="3" strokeLinecap="round" />
        <path d="M25 82 L22 54" stroke="#57534e" strokeWidth="3.5" strokeLinecap="round" />
        {/* Mesa */}
        <rect x="66" y="70" width="80" height="5" rx="2" fill="#a16207" />
        <path d="M72 75 L72 104 M140 75 L140 104" stroke="#854d0e" strokeWidth="3.5" strokeLinecap="round" />
        {/* Laptop de lado: base y pantalla abierta mirándolo a él */}
        <rect x="70" y="66" width="30" height="4" rx="1" fill="#475569" />
        <path d="M70 66 L64 42" stroke="#334155" strokeWidth="4" strokeLinecap="round" />
        <path className="agente-util__brillo" d="M72 64 L66 44" stroke="#93c5fd" strokeWidth="1.2" strokeLinecap="round" />
        {/* Taza */}
        <path d="M118 60 h12 v10 h-12z" fill="#f8fafc" stroke="#334155" strokeWidth="1" />
        <path d="M130 62 q5 3 0 6" stroke="#334155" strokeWidth="1.2" fill="none" />
      </svg>
      {/* Lo que se ve en la pantalla, en grande arriba de la mesa */}
      <div className="agente-util__pantalla" data-tipo={tipo} data-fase={fase}>
        <div className="agente-util__texto agente-util__pantalla-contenido">
          {tipo === "junta" ? (
            <>
              <div className="agente-util__caras">{["🙂", "😐", "🥱", "🙂", "🤓", "😶"].map((c, i) => <span key={i}>{c}</span>)}</div>
              <small>{fase === "pregunta" ? "🎤 «¿Y tú qué opinas?»" : "Junta · 1 h 30 min"}</small>
            </>
          ) : fase === "lee" ? (
            <>
              <b>stackoverflow.com</b>
              <small>How to center a div?</small>
            </>
          ) : (
            <>
              <b>😵 No se puede acceder</b>
              <small>Tardó demasiado en responder</small>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Wi-Fi: el letrerito de "Reconectando…", la silla para subirse y las rayitas de señal. */
function Wifi({ fase }: { fase: string }) {
  return (
    <>
      {fase === "senal" || fase === "conecta" ? (
        <svg viewBox={`0 0 80 ${PISO + 6}`} width="80" height={PISO + 6}>
          <rect x="22" y="82" width="36" height="5" rx="2" fill="#78716c" />
          <path d="M26 87 L24 104 M54 87 L56 104" stroke="#57534e" strokeWidth="3" strokeLinecap="round" />
          <path d="M23 82 L20 60" stroke="#57534e" strokeWidth="3.5" strokeLinecap="round" />
        </svg>
      ) : null}
      <div className="agente-util__texto agente-util__wifi" data-fase={fase}>
        <span className="agente-util__barras"><i /><i /><i /></span>
        {fase === "lag" ? "Reconectando…" : fase === "senal" ? "Buscando señal…" : "¡Conectado!"}
      </div>
    </>
  );
}

/** Campamento: tienda, fogata y la cobija con la que está tapado (hasta que llega el oso). */
function Campamento({ fase }: { fase: string }) {
  const tapado = fase === "fogata" || fase === "dormir" || fase === "llega-oso";
  return (
    <svg viewBox={`0 0 190 ${PISO + 6}`} width="190" height={PISO + 6}>
      {/* Tienda */}
      <path d="M118 104 L146 50 L178 104 Z" fill="#16a34a" stroke="#14532d" strokeWidth="1.5" />
      <path d="M146 50 L140 104 L152 104 Z" fill="#14532d" />
      <path d="M146 50 L146 44" stroke="#78350f" strokeWidth="2" />
      {/* Fogata */}
      <path d="M78 104 L100 96 M80 96 L100 104" stroke="#78350f" strokeWidth="3.5" strokeLinecap="round" />
      <path className="agente-util__flama" d="M89 98 C82 90 86 82 89 76 C92 82 97 88 89 98 Z" fill="#f97316" />
      <path className="agente-util__flama" d="M89 98 C86 93 88 88 89 84 C91 88 93 92 89 98 Z" fill="#fde047" />
      {/* Cobija a cuadros, sobre el personaje sentado */}
      {tapado && (
        <g className="agente-util__cobija">
          <path d="M24 58 Q40 50 60 56 L64 96 Q42 102 20 96 Z" fill="#dc2626" stroke="#7f1d1d" strokeWidth="1.2" />
          <path d="M22 70 L62 68 M21 82 L63 81 M34 54 L32 99 M48 53 L49 100" stroke="#fca5a5" strokeWidth="2" opacity="0.8" />
        </g>
      )}
    </svg>
  );
}

/** Carrito de elotes con sombrilla, mirando a la derecha. */
function CarritoElotes() {
  return (
    <svg viewBox="0 0 70 70" width="70" height="70">
      <path d="M8 18 Q35 0 62 18 Z" fill="#f59e0b" stroke="#b45309" strokeWidth="1.2" />
      <path d="M20 14 Q35 4 50 14" stroke="#fef3c7" strokeWidth="2" fill="none" />
      <path d="M35 18 L35 36" stroke="#6b7280" strokeWidth="2" />
      <rect x="10" y="36" width="50" height="22" rx="3" fill="#fef3c7" stroke="#92400e" strokeWidth="1.5" />
      <path d="M16 34 l4 -10 l4 10z M26 34 l4 -12 l4 12z" fill="#facc15" stroke="#a16207" strokeWidth="0.8" />
      <path d="M60 42 L68 34" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="20" cy="62" r="6" fill="#1f2937" />
      <circle cx="20" cy="62" r="2" fill="#d1d5db" />
      <circle cx="50" cy="62" r="6" fill="#1f2937" />
      <circle cx="50" cy="62" r="2" fill="#d1d5db" />
    </svg>
  );
}

/** Oso caminando en cuatro patas, mirando a la derecha; con la cobija en el hocico. */
function Oso({ conCobija }: { conCobija: boolean }) {
  return (
    <svg viewBox="0 0 76 52" width="76" height="52">
      <g className="agente-actor__patas">
        <rect x="14" y="34" width="8" height="16" rx="3" fill="#5b3a1e" />
        <rect x="50" y="34" width="8" height="16" rx="3" fill="#5b3a1e" />
      </g>
      <g className="agente-actor__patas agente-actor__patas--2">
        <rect x="22" y="34" width="8" height="16" rx="3" fill="#6b4423" />
        <rect x="58" y="34" width="8" height="16" rx="3" fill="#6b4423" />
      </g>
      <ellipse cx="38" cy="30" rx="28" ry="15" fill="#7c4a24" />
      <circle cx="64" cy="22" r="11" fill="#7c4a24" />
      <circle cx="60" cy="12" r="4" fill="#7c4a24" />
      <circle cx="60" cy="12" r="2" fill="#5b3a1e" />
      <ellipse cx="72" cy="25" rx="5" ry="4" fill="#c08457" />
      <circle cx="75" cy="24" r="1.6" fill="#111827" />
      <circle cx="66" cy="19" r="1.4" fill="#111827" />
      {conCobija && (
        <g>
          <path d="M70 28 Q60 40 40 38 Q22 36 14 46 L30 50 Q50 52 72 32 Z" fill="#dc2626" stroke="#7f1d1d" strokeWidth="1" />
          <path d="M60 36 L44 44 M50 37 L34 47" stroke="#fca5a5" strokeWidth="2" opacity="0.8" />
        </g>
      )}
    </svg>
  );
}
