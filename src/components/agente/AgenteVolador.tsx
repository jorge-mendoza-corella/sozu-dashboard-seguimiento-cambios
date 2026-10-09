/**
 * El agente de repos como personaje: un cyborg viejo y sabio (goggles de latón,
 * media cara metálica, brazo robótico) que vuela por la pantalla como
 * superhéroe. Clic → abre el chat.
 *
 * Comportamiento (máquina de estados, `requestAnimationFrame`):
 *   · volar     puño al frente hacia donde va; traza curvas suaves y nunca
 *               repite la misma trayectoria.
 *   · paredes   al chocar a izquierda/derecha se voltea (la mano cambia de lado)
 *               y sale con otro ángulo.
 *   · techo     voltereta y se impulsa hacia abajo.
 *   · piso      se agacha y brinca para volver a despegar, o aterriza y camina
 *               un rato (a veces se queda quieto, pensando) antes de brincar.
 *   · pausa     con el mouse encima, con foco de teclado o con el chat abierto
 *               se congela: un blanco que se mueve no se puede atinar.
 *
 * La física escribe `transform` directo en el DOM por frame (sin re-render de
 * React); React solo se entera de los cambios de pose, que son pocos.
 * Con `prefers-reduced-motion` no vuela: se queda parado abajo a la izquierda.
 */
import { useEffect, useRef, useState } from "react";
import "./personaje.css";

type Pose = "volar" | "caminar" | "quieto" | "agachar" | "despegar" | "girar";

interface Props {
  /** El chat está abierto: el personaje se queda quieto donde está. */
  pausado: boolean;
  onClick: () => void;
}

const TAM = 80;
const MARGEN = 8;
/** Alto del header sticky: no vuela por encima de la navegación. */
const TECHO = 64;
const VEL_VUELO: [number, number] = [150, 230];
const VEL_CAMINAR = 48;

const azar = (a: number, b: number) => a + Math.random() * (b - a);

export function AgenteVolador({ pausado, onClick }: Props) {
  const raiz = useRef<HTMLButtonElement>(null);
  const orientacion = useRef<HTMLDivElement>(null);
  const inclinacion = useRef<HTMLDivElement>(null);
  // Con movimiento reducido arranca (y se queda) de pie.
  const [pose, setPose] = useState<Pose>(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "quieto" : "volar",
  );
  const [pausaLocal, setPausaLocal] = useState(false);
  const pausaRef = useRef(false);
  useEffect(() => {
    pausaRef.current = pausado || pausaLocal;
  }, [pausado, pausaLocal]);

  useEffect(() => {
    const el = raiz.current;
    if (!el) return;
    const reducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const piso = () => window.innerHeight - TAM - MARGEN;
    const derecha = () => window.innerWidth - TAM - MARGEN;

    if (reducido) {
      const colocar = () => { el.style.transform = `translate3d(${MARGEN + 8}px, ${piso()}px, 0)`; };
      colocar();
      window.addEventListener("resize", colocar);
      return () => window.removeEventListener("resize", colocar);
    }

    // Arranca entrando desde la izquierda, a media altura.
    const s = {
      x: MARGEN,
      y: Math.max(TECHO, window.innerHeight * 0.45),
      vel: azar(...VEL_VUELO),
      angulo: azar(-0.35, 0.25), // radianes; 0 = horizontal, negativo = sube
      giro: 0, // curvatura actual (rad/s)
      dir: 1 as 1 | -1, // hacia dónde mira
      pose: "volar" as Pose,
      hasta: 0, // fin de la pose temporal (ms)
      siguiente: "despegar" as Pose, // qué sigue después de agacharse
      proximaCurva: 0,
      ganasDeAterrizar: performance.now() + azar(14_000, 26_000),
      inclinado: 0, // grados, suavizado
      tiempoBob: 0,
    };

    let poseActual: Pose = "volar";
    const cambiarPose = (p: Pose, durMs = 0) => {
      s.pose = p;
      s.hasta = durMs ? performance.now() + durMs : 0;
      if (p !== poseActual) {
        poseActual = p;
        setPose(p);
      }
    };

    const despegar = () => {
      cambiarPose("despegar", 220);
      s.angulo = azar(-1.25, -0.55); // sale hacia arriba, cada vez distinto
      s.vel = azar(...VEL_VUELO) * 1.25;
      if (Math.random() < 0.35) s.dir = (s.dir * -1) as 1 | -1;
    };

    let previo = performance.now();
    let frame = 0;

    const paso = (ahora: number) => {
      frame = requestAnimationFrame(paso);
      const dt = Math.min((ahora - previo) / 1000, 0.05);
      previo = ahora;
      if (pausaRef.current) return;

      const fin = s.hasta && ahora >= s.hasta;

      switch (s.pose) {
        case "volar":
        case "despegar":
        case "girar": {
          if (s.pose === "despegar" && fin) cambiarPose("volar");
          if (s.pose === "girar" && fin) {
            // Se impulsa hacia abajo después de la voltereta.
            cambiarPose("volar");
            s.angulo = azar(0.45, 1.05);
            s.vel = azar(...VEL_VUELO) * 1.15;
          }
          // Curvas: cada pocos segundos cambia la curvatura, así nunca repite.
          if (ahora >= s.proximaCurva) {
            s.giro = azar(-0.5, 0.5);
            s.proximaCurva = ahora + azar(1600, 3800);
          }
          if (ahora >= s.ganasDeAterrizar) s.giro = 0.9; // pica hacia el piso
          s.angulo = Math.max(-1.3, Math.min(1.3, s.angulo + s.giro * dt));
          // La velocidad vuelve sola a su crucero después de un impulso.
          s.vel += (190 - s.vel) * Math.min(1, dt * 0.6);

          s.tiempoBob += dt;
          s.x += Math.cos(s.angulo) * s.vel * dt * s.dir;
          s.y += Math.sin(s.angulo) * s.vel * dt + Math.sin(s.tiempoBob * 3) * 0.25;

          // Paredes: se voltea y sale con otro ángulo.
          if (s.x <= MARGEN || s.x >= derecha()) {
            s.x = Math.max(MARGEN, Math.min(derecha(), s.x));
            s.dir = (s.x <= MARGEN ? 1 : -1) as 1 | -1;
            s.angulo = Math.max(-1, Math.min(1, -s.angulo * 0.5 + azar(-0.45, 0.45)));
            s.vel = azar(...VEL_VUELO);
          }
          // Techo: voltereta.
          if (s.y <= TECHO && s.pose === "volar") {
            s.y = TECHO;
            cambiarPose("girar", 520);
            s.angulo = 0.2;
            s.vel = 60;
          }
          // Piso: brinca de nuevo o aterriza a caminar.
          if (s.y >= piso()) {
            s.y = piso();
            const aterriza = ahora >= s.ganasDeAterrizar || Math.random() < 0.3;
            if (aterriza) {
              s.ganasDeAterrizar = ahora + azar(18_000, 32_000);
              cambiarPose("agachar", 200);
              s.siguiente = "caminar";
            } else {
              cambiarPose("agachar", 150);
              s.siguiente = "despegar";
            }
          }
          break;
        }
        case "agachar": {
          if (fin) {
            if (s.siguiente === "caminar") {
              cambiarPose("caminar", azar(3500, 7500));
              if (Math.random() < 0.5) s.dir = (s.dir * -1) as 1 | -1;
            } else despegar();
          }
          break;
        }
        case "caminar": {
          s.x += VEL_CAMINAR * dt * s.dir;
          if (s.x <= MARGEN || s.x >= derecha()) {
            s.x = Math.max(MARGEN, Math.min(derecha(), s.x));
            s.dir = (s.dir * -1) as 1 | -1;
          }
          if (fin) {
            if (Math.random() < 0.35) cambiarPose("quieto", azar(4000, 9000));
            else {
              cambiarPose("agachar", 180);
              s.siguiente = "despegar";
            }
          }
          break;
        }
        case "quieto": {
          if (fin) {
            cambiarPose("agachar", 180);
            s.siguiente = "despegar";
          }
          break;
        }
      }

      // Inclinación: en vuelo el cuerpo se acuesta en la dirección del avance
      // (cabeza al frente); en el piso, de pie. Suavizado para que no tiemble.
      const objetivo =
        s.pose === "volar" || s.pose === "despegar"
          ? Math.max(25, Math.min(155, 90 + (s.angulo * 180) / Math.PI))
          : 0;
      s.inclinado += (objetivo - s.inclinado) * Math.min(1, dt * 7);

      el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
      if (inclinacion.current) inclinacion.current.style.transform = `rotate(${s.inclinado.toFixed(1)}deg)`;
      if (orientacion.current) orientacion.current.style.transform = `scaleX(${s.dir})`;
    };

    frame = requestAnimationFrame(paso);
    const alRedimensionar = () => {
      s.x = Math.min(s.x, derecha());
      s.y = Math.min(s.y, piso());
    };
    window.addEventListener("resize", alRedimensionar);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", alRedimensionar);
    };
  }, []);

  const congelar = (v: boolean) => () => setPausaLocal(v);

  return (
    <button
      ref={raiz}
      type="button"
      className="agente-volador z-30"
      aria-label="Abrir el agente de repos (Alt+K)"
      aria-keyshortcuts="Alt+K"
      data-pausa={pausaLocal || undefined}
      onClick={onClick}
      onPointerEnter={congelar(true)}
      onPointerLeave={congelar(false)}
      onFocus={congelar(true)}
      onBlur={congelar(false)}
    >
      <span className="agente-volador__globo">Agente de repos · Alt+K</span>
      <div ref={orientacion} className="agente-volador__orientacion">
        <div ref={inclinacion} className="agente-volador__inclinacion">
          <Personaje pose={pose} />
        </div>
      </div>
    </button>
  );
}

/** Dibujo de pie y mirando a la derecha; las poses las mueve personaje.css. */
export function Personaje({ pose }: { pose: Pose }) {
  return (
    <svg viewBox="0 0 96 96" className="agente-volador__sprite" data-pose={pose} aria-hidden>
      <defs>
        <linearGradient id="pj-laton" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3d27a" />
          <stop offset="0.55" stopColor="#c99a3b" />
          <stop offset="1" stopColor="#7a5418" />
        </linearGradient>
        <linearGradient id="pj-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#52525b" />
          <stop offset="1" stopColor="#18181b" />
        </linearGradient>
        <linearGradient id="pj-camisa" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b929c" />
          <stop offset="1" stopColor="#5f6670" />
        </linearGradient>
        <linearGradient id="pj-acero" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d4d4d8" />
          <stop offset="1" stopColor="#71717a" />
        </linearGradient>
        <radialGradient id="pj-brillo">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="1" stopColor="#0891b2" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g className="agente-volador__cuerpo">
        {/* Capa */}
        <path className="pj-capa" d="M38 37 Q48 34 58 37 L67 80 Q57 75 48 81 Q39 75 29 80 Z" fill="#7f1d1d" stroke="#450a0a" strokeWidth="0.8" />

        {/* Brazo de atrás (de carne, manga de camisa) */}
        <g className="pj-brazo">
          <rect x="35" y="38" width="6.5" height="22" rx="3.2" fill="#6b727c" />
          <circle cx="38.2" cy="61" r="3.2" fill="#d9a07a" />
        </g>

        {/* Piernas */}
        <g className="pj-pierna-a">
          <rect x="41.5" y="62" width="7" height="24" rx="2.4" fill="#1e3a5f" />
          <ellipse cx="45.5" cy="87.5" rx="5.2" ry="2.8" fill="#1c1917" />
        </g>
        <g className="pj-pierna-b">
          <rect x="48.5" y="62" width="7" height="24" rx="2.4" fill="#24476f" />
          <ellipse cx="53" cy="87.5" rx="5.2" ry="2.8" fill="#292524" />
        </g>

        {/* Torso: camisa gris con botones y parche de latón en el hombro */}
        <path d="M37 36 Q48 32.5 59 36 L61.5 64.5 Q48 67.5 34.5 64.5 Z" fill="url(#pj-camisa)" />
        <path d="M44 36 L48 41 L52 36" fill="none" stroke="#4b5260" strokeWidth="1.2" />
        <line x1="48" y1="41" x2="48" y2="64" stroke="#4b5260" strokeWidth="0.7" />
        {[45, 51, 57].map((y) => <circle key={y} cx="48" cy={y} r="0.9" fill="#c99a3b" />)}
        <rect x="51" y="45" width="6" height="5" rx="0.8" fill="none" stroke="#4b5260" strokeWidth="0.7" />

        {/* Cuello mecánico */}
        <rect x="45" y="29" width="6.5" height="7.5" rx="1.5" fill="url(#pj-metal)" />
        <line x1="46" y1="31.5" x2="50.5" y2="31.5" stroke="#c99a3b" strokeWidth="0.7" />
        <line x1="46" y1="34" x2="50.5" y2="34" stroke="#c99a3b" strokeWidth="0.7" />

        {/* Cabeza */}
        <ellipse cx="49" cy="20" rx="9.2" ry="11.2" fill="#e2ad86" />
        {/* Media cara metálica (lado de atrás) con remaches */}
        <path d="M40.2 15 Q39 25 43.5 30.5 L47.5 30.5 L46.5 22 L47.5 15 Z" fill="url(#pj-acero)" stroke="#c99a3b" strokeWidth="0.5" />
        <circle cx="42.4" cy="18" r="0.6" fill="#e9c46a" />
        <circle cx="42" cy="25" r="0.6" fill="#e9c46a" />
        <circle cx="45" cy="29" r="0.6" fill="#e9c46a" />
        <circle className="pj-ojo-robot" cx="44.2" cy="21.2" r="2.6" fill="url(#pj-brillo)" />
        <circle cx="44.2" cy="21.2" r="0.9" fill="#a5f3fc" />
        {/* Ojo, ceja dura y arrugas */}
        <ellipse cx="53.4" cy="20.6" rx="1.5" ry="1.3" fill="#f8fafc" />
        <circle cx="53.9" cy="20.7" r="0.85" fill="#3f4d3a" />
        <path d="M50.5 17.6 Q53.5 16.2 56.6 17.8" fill="none" stroke="#1c1917" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M51 23.3 Q53 24.2 55 23.4" fill="none" stroke="#b9805d" strokeWidth="0.5" />
        {/* Nariz larga */}
        <path d="M56.3 18.8 Q62.2 23.6 57 25.6 Q56.4 25.7 56 25.2" fill="#d79b74" stroke="#b9805d" strokeWidth="0.5" />
        {/* Boca seria */}
        <path d="M52.6 28.1 L56 27.9" stroke="#7c4a33" strokeWidth="0.9" strokeLinecap="round" />
        {/* Pelo negro peinado hacia atrás */}
        <path d="M39.4 18 Q37 6.5 49 5.4 Q60.5 5 59.4 13.8 Q55 9.6 47.8 11.3 Q42.6 12.8 41.5 19 Z" fill="#111827" />
        <path d="M43 8.4 Q50 5.8 57 8.6" fill="none" stroke="#374151" strokeWidth="0.8" />
        {/* Goggles de latón en la frente */}
        <rect x="39.6" y="11.2" width="20.4" height="2.9" rx="1.2" fill="url(#pj-laton)" />
        <circle cx="48.5" cy="11.6" r="3.4" fill="url(#pj-laton)" />
        <circle cx="48.5" cy="11.6" r="2.2" fill="#e5e7eb" />
        <circle cx="55.6" cy="11.6" r="3.4" fill="url(#pj-laton)" />
        <circle cx="55.6" cy="11.6" r="2.2" fill="#e5e7eb" />
        <circle cx="47.8" cy="10.9" r="0.7" fill="#fff" />
        <circle cx="54.9" cy="10.9" r="0.7" fill="#fff" />

        {/* Brazo robótico (adelante): el del puño de superhéroe */}
        <g className="pj-brazo-robot">
          <circle cx="58" cy="39" r="4.8" fill="url(#pj-laton)" />
          <rect x="54.8" y="40.5" width="6.6" height="11" rx="1.6" fill="url(#pj-metal)" />
          <rect x="54.8" y="44" width="6.6" height="1.6" fill="url(#pj-laton)" />
          <g className="pj-antebrazo">
          <circle cx="58.1" cy="51.6" r="2.3" fill="url(#pj-laton)" />
          <rect x="55.2" y="52.4" width="5.8" height="9" rx="1.4" fill="url(#pj-metal)" />
          <line x1="58.1" y1="53.6" x2="58.1" y2="60.4" stroke="#22d3ee" strokeWidth="0.9" strokeLinecap="round" />
          {/* Puño */}
          <rect x="54" y="60.6" width="8.2" height="7.2" rx="2" fill="url(#pj-laton)" stroke="#5c3d0f" strokeWidth="0.5" />
          <line x1="56" y1="61.4" x2="56" y2="67" stroke="#5c3d0f" strokeWidth="0.45" />
          <line x1="58.1" y1="61.4" x2="58.1" y2="67" stroke="#5c3d0f" strokeWidth="0.45" />
          <line x1="60.2" y1="61.4" x2="60.2" y2="67" stroke="#5c3d0f" strokeWidth="0.45" />
          </g>
        </g>
      </g>
    </svg>
  );
}
