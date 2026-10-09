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
export type Animo = "serio" | "feliz" | "grito" | "aburrido" | "dormido";
type Dialogo = { id: number; texto: string; tipo: "grito" | "habla" | "zzz" };

/** Lo que dice según lo que hace. Las groserías son de oficina, leves. */
const FRASES = {
  volar: ["¡Wiiiii!", "¡Yujuuu!", "¡Ahí voy!", "¡Al infinito… y a prod!", "¡Más rápido que un hotfix!", "¡Arribaaa!", "¡Esto sí es deploy continuo!"],
  techo: ["¡Uff!", "¡Ay, mi cabeza!", "¡Rebote!"],
  aterrizar: ["Aterrizaje perfecto.", "Pies en la tierra.", "¡Tierra firme!"],
  caminar: [
    "¿Alguien revisó ese PR?",
    "Hmm… ¿y si refactorizo?",
    "Los docs no se escriben solos.",
    "Ese bug lo vi venir.",
    "Todo verde en CI… por ahora.",
    "Paso a pasito, commit a commit.",
  ],
  aburrido: ["Qué hueva…", "¡Chin! Nadie me pregunta nada.", "Me lleva… qué aburrido.", "¿Y si mejor me echo un deploy?", "¡Ah, caray! Ni un bug.", "Pinche silencio."],
  hover: ["¿En qué te ayudo?", "¿Le pregunto al código?", "¡Pregúntame!"],
} as const;
const una = (l: readonly string[]) => l[Math.floor(Math.random() * l.length)];

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
  const [animo, setAnimo] = useState<Animo>("feliz");
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
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

    let animoActual: Animo = "feliz";
    const ponerAnimo = (a: Animo) => {
      if (a !== animoActual) {
        animoActual = a;
        setAnimo(a);
      }
    };
    let idDialogo = 0;
    let finDialogo = 0;
    let proximaFrase = performance.now() + azar(1500, 4000);
    const decir = (texto: string, tipo: Dialogo["tipo"] = "habla", ms = 2400) => {
      idDialogo += 1;
      finDialogo = performance.now() + ms;
      setDialogo({ id: idDialogo, texto, tipo });
    };

    let poseActual: Pose = "volar";
    const cambiarPose = (p: Pose, durMs = 0) => {
      s.pose = p;
      s.hasta = durMs ? performance.now() + durMs : 0;
      if (p !== poseActual) {
        poseActual = p;
        setPose(p);
        if (p === "volar" || p === "despegar") ponerAnimo("feliz");
        else if (p === "caminar") ponerAnimo("serio");
        else if (p === "quieto") ponerAnimo("aburrido");
        if (p === "quieto") proximaFrase = performance.now() + azar(1200, 2500);
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
            if (Math.random() < 0.5) decir(una(FRASES.techo), "grito", 1200);
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
              cambiarPose("caminar", azar(4500, 9000));
              if (Math.random() < 0.5) decir(una(FRASES.aterrizar), "habla", 1800);
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
            if (Math.random() < 0.4) cambiarPose("quieto", azar(7000, 13000));
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

      // Globos: uno a la vez, cada pocos segundos según lo que esté haciendo.
      if (finDialogo && ahora >= finDialogo) {
        finDialogo = 0;
        setDialogo(null);
        if (animoActual === "grito") ponerAnimo("feliz");
      }
      if (!finDialogo && ahora >= proximaFrase) {
        if (s.pose === "volar") {
          if (Math.random() < 0.6) {
            ponerAnimo("grito");
            decir(una(FRASES.volar), "grito", 1800);
          }
          proximaFrase = ahora + azar(4000, 9000);
        } else if (s.pose === "caminar") {
          if (Math.random() < 0.7) decir(una(FRASES.caminar));
          proximaFrase = ahora + azar(3500, 7000);
        } else if (s.pose === "quieto") {
          // Primero se aburre (y lo dice); después le da sueño.
          if (animoActual === "aburrido" && Math.random() < 0.55) {
            decir(una(FRASES.aburrido), "habla", 2600);
          } else {
            ponerAnimo("dormido");
            decir("Z z z", "zzz", 3200);
          }
          proximaFrase = ahora + azar(2800, 4500);
        } else proximaFrase = ahora + 1500;
      }

      // Inclinación: en vuelo el cuerpo se acuesta en la dirección del avance
      // (cabeza al frente); en el piso, de pie. Suavizado para que no tiemble.
      const objetivo =
        s.pose === "volar" || s.pose === "despegar"
          ? Math.max(25, Math.min(155, 90 + (s.angulo * 180) / Math.PI))
          : 0;
      s.inclinado += (objetivo - s.inclinado) * Math.min(1, dt * 7);

      el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
      // El globo se acomoda para no salirse: hacia adentro en las orillas y
      // debajo del personaje cuando va pegado al techo.
      const borde = s.x < 110 ? "izq" : s.x > window.innerWidth - TAM - 110 ? "der" : "";
      const arriba = s.y < TECHO + 70 ? "1" : "";
      if (el.dataset.borde !== borde) el.dataset.borde = borde;
      if (el.dataset.arriba !== arriba) el.dataset.arriba = arriba;
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

  const congelar = (v: boolean) => () => {
    setPausaLocal(v);
    if (v) {
      setAnimo("feliz");
      setDialogo({ id: -Date.now(), texto: `${una(FRASES.hover)} · Alt+K`, tipo: "habla" });
    } else setDialogo(null);
  };

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
      {dialogo && !pausado && (
        <span key={dialogo.id} className="agente-volador__dialogo" data-tipo={dialogo.tipo} aria-hidden>
          {dialogo.tipo === "zzz" ? (
            <>
              <i>z</i><i>z</i><i>Z</i>
            </>
          ) : (
            dialogo.texto
          )}
        </span>
      )}
      <span className="agente-volador__globo">Agente de repos · Alt+K</span>
      <div ref={orientacion} className="agente-volador__orientacion">
        <div ref={inclinacion} className="agente-volador__inclinacion">
          <Personaje pose={pose} animo={animo} />
        </div>
      </div>
    </button>
  );
}

/**
 * Dibujo de pie y mirando a la derecha; las poses las mueve personaje.css.
 * Proporciones de héroe: torso en V, extremidades que se adelgazan, todo con
 * curvas. Las articulaciones (hombros 38/58,39 · codo 58.1,51.6 · caderas
 * 45/52,63 · capa 48,37) están fijas: personaje.css gira sobre ellas.
 */
export function Personaje({ pose, animo = "serio" }: { pose: Pose; animo?: Animo }) {
  return (
    <svg viewBox="0 0 96 96" className="agente-volador__sprite" data-pose={pose} data-animo={animo} aria-hidden>
      <defs>
        <linearGradient id="pj-laton" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbe3a0" />
          <stop offset="0.45" stopColor="#d4a446" />
          <stop offset="1" stopColor="#7a5418" />
        </linearGradient>
        <linearGradient id="pj-metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1f1f23" />
          <stop offset="0.5" stopColor="#4b4b55" />
          <stop offset="1" stopColor="#18181b" />
        </linearGradient>
        <linearGradient id="pj-acero" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e4e4e7" />
          <stop offset="0.6" stopColor="#a1a1aa" />
          <stop offset="1" stopColor="#52525b" />
        </linearGradient>
        <linearGradient id="pj-piel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f0c4a0" />
          <stop offset="1" stopColor="#c98c65" />
        </linearGradient>
        <linearGradient id="pj-camisa" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7d8591" />
          <stop offset="0.55" stopColor="#9aa1ab" />
          <stop offset="1" stopColor="#5c636e" />
        </linearGradient>
        <linearGradient id="pj-jean" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1b3352" />
          <stop offset="0.5" stopColor="#2b4f7a" />
          <stop offset="1" stopColor="#172b45" />
        </linearGradient>
        <linearGradient id="pj-capa-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b91c1c" />
          <stop offset="1" stopColor="#5b0d0d" />
        </linearGradient>
        <radialGradient id="pj-brillo">
          <stop offset="0" stopColor="#a5f3fc" />
          <stop offset="0.4" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0891b2" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="pj-cristal" cx="0.35" cy="0.35">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#cbd5e1" />
          <stop offset="1" stopColor="#64748b" />
        </radialGradient>
      </defs>

      <g className="agente-volador__cuerpo">
        {/* Capa: cae de los hombros con pliegues */}
        <g className="pj-capa">
          <path d="M39.5 36.5 C34 47 30.2 62 27.6 81.5 C32.5 78.6 37 82.4 41.6 79.8 C46 83 50.6 79.6 55.2 81.8 C56.6 66 57.6 51 57 36.5 Z" fill="url(#pj-capa-g)" />
          <path d="M37 46 C34.6 58 33.4 68 33 79" fill="none" stroke="#3f0707" strokeWidth="0.6" opacity="0.6" />
          <path d="M46 42 C45 56 44.6 68 45 80.6" fill="none" stroke="#3f0707" strokeWidth="0.6" opacity="0.5" />
        </g>

        {/* Brazo de atrás: manga arremangada y mano */}
        <g className="pj-brazo">
          <path d="M35.4 38.6 C34.2 45 34.4 51.6 35.6 57.6 L40 57.6 C41 51.6 41.4 45 40.9 38.6 C39 37.2 37.2 37.2 35.4 38.6 Z" fill="url(#pj-camisa)" />
          <path d="M35.3 55.6 C37 56.6 39 56.6 40.3 55.6 L40.1 58.2 C38.6 59 37 59 35.6 58.2 Z" fill="#6b727c" />
          <path d="M35.8 58.4 C35.2 61.2 36.4 63.4 38.2 63.4 C40 63.4 41 61.4 40.4 58.4 Z" fill="url(#pj-piel)" />
        </g>

        {/* Pierna de atrás */}
        <g className="pj-pierna-a">
          <path d="M41.4 63 C40.8 70 41.4 77 42.4 84 L47.2 84 C48.2 77 49 70 48.8 63 Z" fill="url(#pj-jean)" />
          <path d="M42.2 83.2 C41.8 86 41.6 88.4 42.4 89.6 L49.8 89.6 C50.6 88.2 49.4 86.6 47.6 85.8 L47.4 83.2 Z" fill="#1c1917" />
          <path d="M42.3 85 L47.5 85" stroke="#c99a3b" strokeWidth="0.6" />
        </g>
        {/* Pierna de adelante */}
        <g className="pj-pierna-b">
          <path d="M48.4 63 C47.8 70 48.4 77 49.4 84 L54.2 84 C55.2 77 56 70 55.8 63 Z" fill="url(#pj-jean)" />
          <path d="M49.2 83.2 C48.8 86 48.6 88.4 49.4 89.6 L56.8 89.6 C57.6 88.2 56.4 86.6 54.6 85.8 L54.4 83.2 Z" fill="#292524" />
          <path d="M49.3 85 L54.5 85" stroke="#c99a3b" strokeWidth="0.6" />
        </g>

        {/* Torso en V: hombros anchos, cintura angosta */}
        <path d="M36.2 37.4 C37.2 34.6 42 33.2 48 33.2 C54 33.2 58.8 34.6 59.8 37.4 C61 44.4 59.2 52.4 56.6 60.4 L39.4 60.4 C36.8 52.4 35 44.4 36.2 37.4 Z" fill="url(#pj-camisa)" />
        <path d="M54 35 C57.6 42 57.6 52 55.4 60.2" fill="none" stroke="#4b5260" strokeWidth="0.5" opacity="0.5" />
        {/* Cuello de camisa */}
        <path d="M43.6 34 L48 39.6 L46.2 34.4 Z M52.4 34 L48 39.6 L49.8 34.4 Z" fill="#6b727c" />
        <path d="M48 39.6 L48 60" stroke="#565d68" strokeWidth="0.6" />
        {[44, 49.5, 55].map((y) => <circle key={y} cx="48.9" cy={y} r="0.85" fill="#d4a446" />)}
        {/* Emblema de engrane en el pecho */}
        <g transform="translate(42.6 44.6)">
          <circle r="2.6" fill="url(#pj-laton)" />
          {[0, 45, 90, 135].map((a) => (
            <rect key={a} x="-0.7" y="-3.4" width="1.4" height="6.8" rx="0.4" fill="url(#pj-laton)" transform={`rotate(${a})`} />
          ))}
          <circle r="1.1" fill="#3f2a0b" />
        </g>
        {/* Cinturón con hebilla */}
        <path d="M39.2 60 L56.8 60 L56.6 63.4 L39.4 63.4 Z" fill="#292018" />
        <rect x="45.6" y="59.6" width="4.8" height="4.2" rx="1" fill="url(#pj-laton)" stroke="#5c3d0f" strokeWidth="0.4" />

        {/* Cuello mecánico con cables */}
        <path d="M45 29.4 C45 32 44.6 34 44.2 35.6 L51.8 35.6 C51.4 34 51 32 51 29.4 Z" fill="url(#pj-metal)" />
        <path d="M46 31 C47.6 31.8 48.6 31.8 50 31 M45.6 33.2 C47.4 34 48.8 34 50.4 33.2" fill="none" stroke="#d4a446" strokeWidth="0.6" />

        {/* Cabeza: mandíbula marcada, nariz larga */}
        <path d="M41 16 C41 9.4 45.4 6.6 50 6.8 C55.4 7.1 58.6 10.8 58.7 15.6 C58.8 18.4 61.6 20.6 61.4 22.8 C61.2 24.6 59.2 24.8 58.8 26 C58.2 29.6 55.6 31.8 52 32 C47.6 32.2 43.6 30.2 42.1 26.6 C40.7 23.4 41 19.6 41 16 Z" fill="url(#pj-piel)" />
        <path d="M57.8 27.2 C56.4 29.4 54.6 30.6 52.4 30.8" fill="none" stroke="#a8704d" strokeWidth="0.5" />
        <path d="M54.6 23.4 C55.6 24.4 56.6 24.6 57.6 24.4" fill="none" stroke="#a8704d" strokeWidth="0.45" />
        {/* Media cara de acero con remaches y ojo que brilla */}
        <path d="M41.2 15.4 C40.6 20.4 40.9 25.6 43.1 28.8 C44.6 30.8 46.4 31.7 48 31.8 L47.4 24.4 C46.2 22.2 46.3 19 47.7 16.2 Z" fill="url(#pj-acero)" stroke="#d4a446" strokeWidth="0.5" />
        <path d="M43 18 C42.6 22 42.8 25.6 44.4 28.2" fill="none" stroke="#71717a" strokeWidth="0.4" />
        {[[42.6, 17.2], [42.2, 25.4], [45.6, 29.6]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="0.55" fill="#f3d27a" />)}
        <circle className="pj-ojo-robot" cx="44.8" cy="21.4" r="3" fill="url(#pj-brillo)" />
        <circle cx="44.8" cy="21.4" r="1" fill="#ecfeff" />
        {/* Ojo: abierto (con párpado caído si está aburrido) o cerrado (dormido) */}
        <g className="pj-ojo-abierto">
          <path d="M51.6 20.8 C52.4 19.6 54.6 19.4 55.6 20.6 C54.6 21.8 52.6 21.9 51.6 20.8 Z" fill="#f8fafc" />
          <circle className="pj-pupila" cx="54" cy="20.7" r="0.95" fill="#3b5240" />
          <circle cx="54.3" cy="20.4" r="0.3" fill="#fff" />
          <path className="pj-parpado" d="M51.3 20.9 C52.2 19 54.8 18.8 55.9 20.6 Z" fill="#d9a07a" />
        </g>
        <path className="pj-ojo-cerrado" d="M51.6 20.9 C52.8 21.9 54.6 21.9 55.7 20.8" fill="none" stroke="#3f2a1d" strokeWidth="0.8" strokeLinecap="round" />
        {/* Cejas */}
        <path className="pj-ceja pj-ceja--seria" d="M50.6 18.2 C52.6 16.6 55.4 16.6 57.4 18.2" fill="none" stroke="#111827" strokeWidth="1.6" strokeLinecap="round" />
        <path className="pj-ceja pj-ceja--feliz" d="M50.6 17.4 C52.6 14.8 55.6 14.8 57.4 16.8" fill="none" stroke="#111827" strokeWidth="1.6" strokeLinecap="round" />
        <path className="pj-ceja pj-ceja--aburrida" d="M50.6 18.6 C52.8 18.2 55.4 18.4 57.4 19.2" fill="none" stroke="#111827" strokeWidth="1.6" strokeLinecap="round" />
        {/* Bocas */}
        <path className="pj-boca pj-boca--seria" d="M54.6 28.6 C55.6 28.2 56.6 28.2 57.4 28.5" fill="none" stroke="#6b3a24" strokeWidth="0.9" strokeLinecap="round" />
        <path className="pj-boca pj-boca--feliz" d="M53.8 27.6 C55 29.6 57 29.6 58 27.8" fill="none" stroke="#6b3a24" strokeWidth="1" strokeLinecap="round" />
        <g className="pj-boca pj-boca--grito">
          <path d="M53.8 27 C54.2 31 57.6 31.2 58.2 27.2 C56.8 26.4 55.2 26.4 53.8 27 Z" fill="#3b0f0a" />
          <path d="M54.6 29.6 C55.6 30.4 56.8 30.4 57.6 29.6 C56.8 29 55.4 29 54.6 29.6 Z" fill="#e05a5a" />
          <path d="M54.2 27.1 C55.4 26.7 56.8 26.7 57.9 27.2" fill="none" stroke="#fff" strokeWidth="0.55" />
        </g>
        <path className="pj-boca pj-boca--aburrida" d="M54.4 28.9 C55.4 28.3 56.6 28.4 57.6 29" fill="none" stroke="#6b3a24" strokeWidth="0.9" strokeLinecap="round" />
        <ellipse className="pj-boca pj-boca--dormida" cx="56" cy="28.6" rx="0.9" ry="0.7" fill="#3b0f0a" />
        {/* Pelo: copete peinado hacia atrás */}
        <path d="M40.4 18 C38.2 10.6 41.2 4.2 48.6 3.4 C55.4 2.6 61 6.2 60.2 12 C58 9.4 54.6 8.6 50.8 9.4 C46.4 10.4 43.4 12.8 42.4 18.6 Z" fill="#111827" />
        <path d="M43 9 C46 5.8 51.4 4.8 56.4 6.6" fill="none" stroke="#4b5563" strokeWidth="0.8" strokeLinecap="round" />
        {/* Goggles de latón */}
        <path d="M40.6 13.6 C46 11.4 53 11 59.6 12.6 L59.4 15.2 C53 13.8 46.2 14.2 40.9 16.4 Z" fill="url(#pj-laton)" />
        <circle cx="48.6" cy="12.6" r="3.6" fill="url(#pj-laton)" />
        <circle cx="48.6" cy="12.6" r="2.4" fill="url(#pj-cristal)" />
        <circle cx="55.8" cy="12.4" r="3.6" fill="url(#pj-laton)" />
        <circle cx="55.8" cy="12.4" r="2.4" fill="url(#pj-cristal)" />

        {/* Brazo robótico: hombrera, segmentos redondeados, puño */}
        <g className="pj-brazo-robot">
          <path d="M53.4 37.6 C53.6 34 56.4 32.6 59 33 C62 33.4 63.6 36 63.2 39 C62.8 41.6 60.6 42.6 58 42.4 C55.6 42.2 53.4 40.6 53.4 37.6 Z" fill="url(#pj-laton)" stroke="#6b4a14" strokeWidth="0.4" />
          <path d="M55.4 39.6 C58 38.4 60.6 39.2 61.4 41 L60.6 50.6 C59 51.4 57.2 51.4 55.6 50.6 Z" fill="url(#pj-metal)" />
          <path d="M55.6 44.2 C57.6 44.8 59.4 44.8 61 44.2" fill="none" stroke="#d4a446" strokeWidth="0.9" />
          <g className="pj-antebrazo">
            <circle cx="58.1" cy="51.6" r="2.6" fill="url(#pj-laton)" stroke="#6b4a14" strokeWidth="0.4" />
            <path d="M55.6 52.8 C57.2 52 59 52 60.6 52.8 L61.6 60.4 C59.4 61.4 56.8 61.4 54.6 60.4 Z" fill="url(#pj-metal)" />
            <path d="M58.1 54 L58.1 59.6" stroke="#22d3ee" strokeWidth="1" strokeLinecap="round" />
            <path d="M58.1 54 L58.1 59.6" stroke="#a5f3fc" strokeWidth="0.35" strokeLinecap="round" />
            {/* Puño: nudillos y pulgar */}
            <path d="M54.2 60.6 C54 63.6 54.4 66.4 56 67.6 C57.8 68.8 60.4 68.4 61.6 66.8 C62.6 65 62.4 62.4 62 60.6 Z" fill="url(#pj-laton)" stroke="#5c3d0f" strokeWidth="0.45" />
            <path d="M55 63.4 C56.6 64 59.8 64 61.6 63.4 M55.4 65.8 C57 66.4 59.6 66.4 61.2 65.6" fill="none" stroke="#7a5418" strokeWidth="0.45" />
            <path d="M54.4 61.6 C53 62.4 52.8 64.2 54 65" fill="none" stroke="#7a5418" strokeWidth="0.9" strokeLinecap="round" />
          </g>
        </g>
      </g>
    </svg>
  );
}
