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
import { createPortal } from "react-dom";
import "./personaje.css";
import { Antojos, Bata, Blusa, BrazoHumano, CabezaCartoon, Camisa, Camiseta, Cola, Filipina, Gi, HojasVestido, Playera, Saco, Vestido } from "./skins";
import { PERSONALIDAD } from "./personalidades";
import { audioDeAviso, callarVoz, hablar } from "./voz";
import { EVENTO_AVISO, EVENTO_AVISO_ENTREGADO, type AvisoParaAvatar } from "@/lib/avisos";
import { nombreAvatar, PALETA, PAREJA, SKINS, useCorreosAvatar, useNombresAvatar, useSkinGeorgIA, type Skin } from "./skinsDatos";
import { ANCHO_UTILERIA, ARRIBA_UTILERIA, partidoDeHoy, partidoEnVivo, partidosSeleccion, setPartidosSeleccion, type TipoUtileria, type Utileria } from "./escenasDatos";
import { cargarPartidosSeleccion } from "@/lib/agenteRepos";
import { UtileriaEscena } from "./escenasExtra";
import {
  dondeFue, EVENTO_DEV_FALLO, EVENTO_DEV_OK, EVENTO_FALLO, EVENTO_FESTEJO, EVENTO_PRD_INICIO, EVENTO_STORE, type DetalleFestejo, type DetalleStore,
} from "@/lib/festejoDeploy";

/** Alerta de tickets pendientes: el personaje aterriza, se para y grita. */
export const EVENTO_ALERTA_TICKETS = "agente:alerta-tickets";
export interface DetalleAlerta {
  /** Frases a gritar, en rotación (p. ej. "¡Jorge! Tienes 3 tickets por checar"). */
  gritos: string[];
}
/** Cuánto grita antes de rendirse y volver a volar (la próxima revisión insiste). */
const ALERTA_MS = 90_000;
/** Avisos: lo que tarda el mensajero en entrar, lo mínimo que grita y lo que tarda en irse. */
const MENSAJERO_ENTRA_MS = 1600;
const MENSAJERO_GRITA_MS = 6500;
const MENSAJERO_SALE_MS = 1400;

/**
 * Una corrida de Claude Code (tickets) terminó: GeorgIA baja y lo actúa.
 *   ok       -> celebra con los brazos arriba, palomita violeta y confeti
 *   pregunta -> ladea la cabeza con un "?" grande; se queda hasta el clic
 *   fallo    -> se sacude con chispazos y humo
 * El clic abre la pestaña de Tickets (AgenteRepos lleva al ticket).
 */
export const EVENTO_CLAUDE = "agente:claude";
export interface DetalleClaude {
  resultado: "ok" | "pregunta" | "fallo";
  folio: string;
  nombre: string;
}
const CLAUDE_OK_MS = 9000;
const CLAUDE_FALLO_MS = 9000;
const CLAUDE_PREGUNTA_MS = 45_000;
/** Escenas que no se interrumpen entre sí (la siguiente espera en la cola). */
const ESCENAS: Pose[] = ["festejo", "llorar", "brinco", "victoria", "pregunta", "chispazo", "arcade", "marometa", "berrinche", "patada",
  "pescar", "jalar", "presume", "perseguir", "coraje", "rumbo", "cafe", "celular", "susto", "pensar"];

const COLORES_CONFETI = ["#f59e0b", "#ef4444", "#22d3ee", "#a855f7", "#22c55e", "#facc15", "#3b82f6", "#ec4899"];

/** Logos para el confeti de las tiendas (siluetas simples, como data URL). */
const LOGO_ANDROID = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#3DDC84" d="M6 10.5h12v7.2a1.3 1.3 0 0 1-1.3 1.3H15v2.6a1.2 1.2 0 0 1-2.4 0V19h-1.2v2.6a1.2 1.2 0 0 1-2.4 0V19H7.3A1.3 1.3 0 0 1 6 17.7zM4.2 10.5a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-2.4 0v-4.8a1.2 1.2 0 0 1 1.2-1.2zm15.6 0a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-2.4 0v-4.8a1.2 1.2 0 0 1 1.2-1.2zM6 9.6a6 6 0 0 1 3.1-4.9L8 3a.3.3 0 0 1 .5-.3l1.2 1.7a6.4 6.4 0 0 1 4.6 0l1.2-1.7a.3.3 0 0 1 .5.3l-1.1 1.7A6 6 0 0 1 18 9.6zm3.4-2.4a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4zm5.2 0a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4z"/></svg>')}`;
const LOGO_APPLE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#111827" d="M16.4 12.6c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.8C6 7 4.5 8 3.6 9.5c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6s1.8-.8 3.3-.8 2 .8 3.3.8 2.2-1.3 3-2.5c1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.3zM14 5.1c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z"/></svg>')}`;

/** Lluvia de confeti a pantalla completa (WAAPI: transform/opacity, se limpia solo). */
function lanzarConfeti(tipo: "colores" | "android" | "ios" = "colores") {
  const capa = document.createElement("div");
  capa.setAttribute("aria-hidden", "true");
  capa.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:60";
  document.body.appendChild(capa);
  const W = window.innerWidth;
  const H = window.innerHeight;
  let ultimo = 0;
  for (let i = 0; i < 160; i++) {
    const p = document.createElement("i");
    const w = 6 + Math.random() * 6;
    // Tiendas: 2 de cada 3 piezas son el logo de la plataforma; el resto, confeti normal.
    const logo = tipo !== "colores" && i % 3 !== 2 ? (tipo === "android" ? LOGO_ANDROID : LOGO_APPLE) : null;
    p.style.cssText = logo
      ? `position:absolute;left:0;top:0;width:${18 + Math.random() * 14}px;aspect-ratio:1;background:url("${logo}") center/contain no-repeat`
      : `position:absolute;left:0;top:0;width:${w}px;height:${w * (Math.random() < 0.5 ? 1.6 : 0.6)}px;` +
        `background:${COLORES_CONFETI[i % COLORES_CONFETI.length]};border-radius:${Math.random() < 0.3 ? "50%" : "1px"}`;
    capa.appendChild(p);
    const x0 = Math.random() * W;
    const deriva = (Math.random() - 0.5) * 260;
    const giro = (Math.random() - 0.5) * 1440;
    const dur = 3400 + Math.random() * 2600;
    const espera = Math.random() * 1400;
    ultimo = Math.max(ultimo, dur + espera);
    p.animate(
      [
        { transform: `translate(${x0}px, -20px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${x0 + deriva * 0.6}px, ${H * 0.55}px) rotate(${giro * 0.6}deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${x0 + deriva}px, ${H + 30}px) rotate(${giro}deg)`, opacity: 0 },
      ],
      // Caída pareja (lineal): es movimiento constante, no una entrada de UI.
      { duration: dur, delay: espera, easing: "linear", fill: "both" },
    );
  }
  setTimeout(() => capa.remove(), ultimo + 200);
}

type Pose = "volar" | "caminar" | "quieto" | "agachar" | "despegar" | "girar" | "festejo" | "alerta" | "llorar" | "brinco"
  | "victoria" | "pregunta" | "chispazo" | "arcade" | "marometa" | "berrinche" | "patada"
  | "pescar" | "jalar" | "presume" | "perseguir" | "coraje" | "rumbo" | "cafe" | "celular" | "susto" | "pensar"
  | "rezar" | "sentado" | "cabeceo" | "teclear" | "jalarpelo" | "senal" | "cubrirse" | "comer" | "enchilado"
  | "explicar" | "encoger" | "forcejeo" | "tropiezo" | "abanicar" | "arrastrar" | "pegar" | "porra"
  // Al contar un chiste, cada avatar a su modo (ver personalidades.ts).
  | "risa" | "sigilo" | "rugido" | "hadouken";
export type Animo = "serio" | "feliz" | "grito" | "aburrido" | "dormido" | "llorando" | "relajado" | "comiendo" | "sorbiendo" | "lamiendo";
/** Cómo vuela: puño al frente, nadando de crol, o boca arriba con las manos en la nuca. */
export type EstiloVuelo = "superman" | "nado" | "relax";
/**
 * Viñeta de manga: plano que resalta una expresión con un texto chusco. Cinco
 * estilos (los elegidos): zoom con líneas de acción, franja de ojos dramáticos,
 * gota de sudor chibi, shoujo con brillos y shock en negativo.
 */
type EstiloManga = "zoom" | "ojos" | "gota" | "shoujo" | "shock";
type Viñeta = { estilo: EstiloManga; animo: Animo; texto: string; snack?: Snack };
type Manga = Viñeta & { id: number; x: number; y: number };
const MANGA_MS = 2800;
const VIÑETAS: Viñeta[] = [
  { estilo: "zoom", animo: "grito", texto: "¡¿OTRO BUG?!" },
  { estilo: "zoom", animo: "grito", texto: "¡¿QUIÉN HIZO MERGE A MAIN?!" },
  { estilo: "zoom", animo: "grito", texto: "¡¡NANI?!" },
  { estilo: "ojos", animo: "aburrido", texto: "…¿neta, cabrón?" },
  { estilo: "ojos", animo: "aburrido", texto: "…te estoy viendo, viernes" },
  { estilo: "ojos", animo: "serio", texto: "…sé lo que hiciste en dev" },
  { estilo: "gota", animo: "serio", texto: "!? ¿Y ese console.log?" },
  { estilo: "gota", animo: "aburrido", texto: "Funciona en mi máquina… 💧" },
  { estilo: "gota", animo: "serio", texto: "¿Quién borró la tabla? 😅" },
  { estilo: "shoujo", animo: "feliz", texto: "✨ Código limpio ✨" },
  { estilo: "shoujo", animo: "relajado", texto: "✨ Cero bugs (mentira) ✨" },
  { estilo: "shock", animo: "grito", texto: "¡¡SE CAYÓ PROD!! …ah no" },
  { estilo: "shock", animo: "grito", texto: "¡¡ME OLVIDÉ DEL HOTFIX!!" },
];
const VIÑETAS_GOLPE: Viñeta[] = [
  { estilo: "zoom", animo: "grito", texto: "¡¡AUCH, QUÉ PUTAZO!!" },
  { estilo: "gota", animo: "llorando", texto: "Mi copete… 💧" },
  { estilo: "shock", animo: "grito", texto: "¡¡VI A DIOS!!" },
  { estilo: "ojos", animo: "aburrido", texto: "…pinche pared" },
];
/** Al empezar un antojo: zoom a la cara con el antojo en la boca. */
const VIÑETAS_SNACK: Record<Snack, Viñeta[]> = {
  pizza: [
    { estilo: "shoujo", animo: "comiendo", snack: "pizza", texto: "✨ Ñam ñam ñam ✨" },
    { estilo: "zoom", animo: "comiendo", snack: "pizza", texto: "¡¡PEPPERONI, CABRÓN!!" },
    { estilo: "gota", animo: "comiendo", snack: "pizza", texto: "Nadie vio nada… 💧" },
  ],
  refresco: [
    { estilo: "shoujo", animo: "sorbiendo", snack: "refresco", texto: "✨ Sluuurp ✨" },
    { estilo: "zoom", animo: "sorbiendo", snack: "refresco", texto: "¡¡CAFEÍNA PARA PROD!!" },
    { estilo: "ojos", animo: "sorbiendo", snack: "refresco", texto: "…sluuurp…" },
  ],
  helado: [
    { estilo: "shoujo", animo: "lamiendo", snack: "helado", texto: "✨ Se me congela el cerebro ✨" },
    { estilo: "zoom", animo: "lamiendo", snack: "helado", texto: "¡¡HELADO A 200 KM/H!!" },
    { estilo: "gota", animo: "lamiendo", snack: "helado", texto: "Se derrite… se derrite… 💧" },
  ],
};
const ANIMO_SNACK: Record<Snack, Animo> = { pizza: "comiendo", refresco: "sorbiendo", helado: "lamiendo" };
const VIÑETAS_STORE: Viñeta[] = [
  { estilo: "shoujo", animo: "feliz", texto: "✨ ¡YA ESTÁ EN LA STORE! ✨" },
  { estilo: "zoom", animo: "grito", texto: "¡¡A HUEVO, RELEASE!!" },
  { estilo: "shock", animo: "grito", texto: "¡¡QUE NO LA RECHACEN!!" },
];
/** Antojo en la mano de atrás: pizza o refresco cuando descansa, helado cuando vuela. */
export type Snack = "pizza" | "refresco" | "helado";
/** Letrero fijo arriba al centro durante el festejo o el llanto. */
type Letrero = {
  tipo: "exito" | "fallo" | "dev" | "dev-fallo" | "store" | "claude" | "claude-pregunta" | "claude-fallo" | "viernes";
  titulo: string;
  linea: string;
  id: number;
};
/** Cuánto dura el llanto por un deploy fallido. */
const LLANTO_MS = 9000;
/** Lo que el letrero se queda en pantalla después de que termina la escena. */
const LETRERO_EXTRA_MS = 4500;
/** Duración del huracán de un deploy a PRD exitoso. */
const FESTEJO_MS = 8000;
type Dialogo = { id: number; texto: string; tipo: "grito" | "habla" | "zzz" };

const FRASES_CLAUDE_OK = [
  (n: string) => `¡A huevo, ${n}! Revisa los PRs`,
  () => "¡Claude ya la armó!",
  () => "¡Dame clic y ves qué hizo!",
  () => "¡Listo, nomás apruébalo!",
];
const FRASES_CLAUDE_PREGUNTA = [
  (n: string) => `¡${n}, Claude no puede seguir sin ti!`,
  () => "¡Dame clic y le contestas!",
  () => "Mmm… ¿y ahora qué le digo?",
  () => "¡Está esperando tu respuesta!",
];
const FRASES_CLAUDE_FALLO = [
  () => "¡Algo tronó en la corrida!",
  (n: string) => `¡${n}, se cayó el trabajo!`,
  () => "¡Dame clic y lo revisas!",
  () => "¡Chispas! Hay que ver el log",
];

/** Lo que dice según lo que hace. Groserías de oficina mexicana: leves, nada de insultos (salvo el arcade). */
const FRASES = {
  volar: [
    "¡Wiiiii!", "¡Yujuuu!", "¡Ahí voy, cabrones!", "¡Al infinito… y a prod!", "¡Más rápido que un hotfix!",
    "¡Arribaaa!", "¡Esto sí es deploy continuo!", "¡A huevo, a volar!", "¡No mames, qué vista!",
    "¡Quítense que llevo prisa!", "¡Soy un pinche cohete!", "¡Vuelo más alto que el uptime!",
    "¡Wuuu, sin tests ni miedo!", "¡Qué chingón es volar!",
  ],
  techo: ["¡Uff!", "¡Ay, mi cabeza!", "¡Rebote!", "¡Uta madre, el techo!", "¡Chale, otra vez el techo!", "¡Auch, cabrón!"],
  pared: ["¡Vuelta en U!", "¡Pared a la vista!", "¡Ups, por acá no!", "¡Ni madres, me regreso!"],
  // Cuando se da contra el techo o una pared: chuscas, para que no siempre diga lo mismo.
  golpe: [
    "¡Ay, qué putazo me di!",
    "¡Uta, ese sí dolió!",
    "¡Mi copete! ¡Me despeiné!",
    "¿Quién puso esa pared ahí?",
    "¡Me lleva! Ya vi estrellitas…",
    "¡Auch! Eso no estaba en el diseño",
    "¡Ni el CI me pega tan duro!",
    "¡Chin! Se me abolló el brazo",
    "¡Pinche pared, otra vez tú!",
    "Estoy bien… estoy bien… ¿dónde estoy?",
    "¡Madres! Necesito un casco",
    "¡Ay, mi chip! Creo que perdí memoria RAM",
    "¡Zas! Bug de colisión confirmado",
    "Eso fue un 500 en mi cabeza",
    "¡No mames, qué madrazo!",
  ],
  aterrizar: ["Aterrizaje perfecto.", "Pies en la tierra.", "¡Tierra firme!", "¡Clavado, a huevo!", "10 de 10 el aterrizaje.", "¡Ni se despeinó el copete!"],
  caminar: [
    "¿Alguien revisó ese PR?", "Hmm… ¿y si refactorizo?", "Los docs no se escriben solos.", "Ese bug lo vi venir.",
    "Todo verde en CI… por ahora.", "Paso a pasito, commit a commit.", "¿Qué pedo con ese merge?",
    "Pinche conflicto de merge…", "Ese console.log no se va a borrar solo.", "¿Quién dejó un TODO del 2024?",
    "Estimé dos días… ya van tres semanas.", "Funciona en mi máquina, ¿eh?", "Chale, otro hotfix el viernes.",
    "Me vale, yo hago rebase.",
  ],
  aburrido: [
    "Qué hueva…", "¡Chin! Nadie me pregunta nada.", "Me lleva… qué aburrido.", "¿Y si mejor me echo un deploy?",
    "¡Ah, caray! Ni un bug.", "Pinche silencio.", "Ni madres, ¿nadie tiene dudas?", "Me estoy oxidando, cabrón.",
    "¿Qué pedo, ya nadie programa?", "Uta, ni un PR en horas.", "Chale, puro scroll y nada de preguntas.",
    "Ya ni el CI me pela.", "Me vale madre, me voy a dormir.",
  ],
  pizza: ["Ñam… una pizzita no se le niega a nadie", "Pepperoni: el mejor lenguaje de programación", "¿Gustas? …no, ya me la acabé", "Pizza fría: desayuno de campeones", "Mmm, con piña no, eh"],
  refresco: ["Glu glu… refresquito", "Ahh, cafeína para el próximo deploy", "Un refresco y a debuggear", "¡Burp! Perdón, perdón", "Bien helado, como debe ser"],
  helado: ["¡Helado a 200 km/h!", "Se me congela el cerebro… ¡pero vale!", "Mmm, de chocolate con menta", "¡No me lo tiren! Es el último", "Volar y helado: combo perfecto"],
  relax: ["Modo crucero activado 😎", "Ahh, aquí relajadito", "Que trabajen los demás", "Despiértenme si truena prod", "Vacaciones a 100 metros de altura"],
  nado: ["¡Estilo libre!", "Crol aéreo, medalla de oro", "Glu glu… ah no, es aire", "¡Michael Phelps quién!", "Brazada, brazada, respiro…"],
  hover: [
    "¿En qué te ayudo?", "¿Le pregunto al código?", "¡Pregúntame!", "¿Qué pedo, qué necesitas?", "A ver, suéltalo.", "¿Otro bug, cabrón?",
    "¡Me atrapaste! Dale clic y platicamos", "¡Ya me agarraste! Un clic y te ayudo", "¡Órale, ya casi! Pícale",
  ],
  // Lo invitan a darle clic: mucha gente no sabe que así se abre el chat.
  atrapameVuelo: [
    "¡No me atrapaaas!", "¡Órale, atrápame!", "¡A que no me das clic!", "¡Ni con el mouse me alcanzas!",
    "¡Clic aquí… si puedes!", "¡Atrápame y te contesto lo que quieras!", "¡Uy, casi! ¡Otra vez!",
    "¡Pícame, no muerdo!", "¡Dale clic, cabrón, no seas así!",
  ],
  atrapame: [
    "Pícame y platicamos 😏", "¿Dudas del código? Dame clic", "Un clic y soy todo tuyo", "Ándale, dame clic, no seas tímido",
    "¿Y si me atrapas? Sé un chingo de los repos", "Psst… si me das clic te ayudo", "Aquí ando, a un clic de distancia",
  ],
} as const;

/** Ya le dieron clic alguna vez: deja de insistir tanto en que lo atrapen. */
const CLAVE_ATRAPADO = "georgia:atrapado";
let yaLoAtraparon = (() => {
  try { return localStorage.getItem(CLAVE_ATRAPADO) === "1"; } catch { return false; }
})();
function marcarAtrapado() {
  if (yaLoAtraparon) return;
  yaLoAtraparon = true;
  try { localStorage.setItem(CLAVE_ATRAPADO, "1"); } catch { /* sin storage: solo dura la sesión */ }
}
/** Qué tan seguido invita a darle clic (mucho al principio, poco después). */
const ganasDeQueLoAtrapen = () => (yaLoAtraparon ? 0.12 : 0.45);

/** Deploy a dev: brinco de gusto (o queja corta si falló). Más modesto que PRD. */
const FRASES_DEV_OK = [
  (r: string) => `¡Ya está en dev ${r}, a probar!`,
  () => "¡A huevo, dev arriba!",
  (r: string) => `¡${r} al día en dev!`,
  () => "¡Wiii, otro deploy a dev!",
];
const FRASES_DEV_FALLO = [
  () => "¡Chale, falló dev!",
  (r: string) => `Uta, ${r} en rojo en dev…`,
  () => "¡No mames, se cayó dev!",
];
/** Cuánto dura el brinco por un deploy a dev. */
const BRINCO_MS = 7000;

/** Envío a tienda: festejo con logos (o llanto si falló). */
const FRASES_STORE_OK = [
  (d: string) => `¡Ya se mandó a ${d}, cabrón!`,
  () => "¡A huevo, release enviado!",
  (d: string) => d.includes("App Store") ? "¡Apple, apruébala o te demando!" : d.includes("TestFlight") ? "¡A probarla, testers!" : "¡Google, ahí te va otra!",
  () => "¡Que la descarguen, que la descarguen!",
  () => "¡Cinco estrellas o me enojo!",
  () => "¡Una app más al mundo, no mames!",
];
const FRASES_STORE_FALLO = [
  (d: string) => `¡No mames, falló el envío a ${d}!`,
  () => "Snif… la tienda me rechazó",
  () => "¡Chale! Revisen los certificados…",
  () => "Pinche firma de la app, otra vez",
];

/** Lamentos cuando un deploy a PRD falla. */
const FRASES_FALLO = [
  (r: string) => `¡Nooo, se cayó ${r}!`,
  (r: string) => `¡No mames, falló el deploy de ${r}!`,
  (r: string) => `Snif… ¿quién rompió ${r}?`,
  () => "¡Chale! Rollback, rollback…",
  () => "Pinche CI, me rompiste el corazón",
  (r: string) => `Alguien revise los logs de ${r}, porfa… snif`,
  () => "¡Uta madre! Y era viernes…",
  (r: string) => `${r} en rojo… me lleva la…`,
  () => "Buaaa… nadie corrió los tests",
];

/** Gritos de festejo cuando un repo llega a PRD. */
const FRASES_DEPLOY = [
  (r: string) => `¡${r} en PRD, a huevo!`,
  (r: string) => `¡Deploy chingón de ${r}!`,
  (r: string) => `¡No mames, ${r} ya está en producción!`,
  (r: string) => `¡${r} sin rollback, cabrones!`,
  (r: string) => `¡Otro deploy limpio de ${r}!`,
  (r: string) => `¡Aumento para el equipo de ${r}!`,
  (r: string) => `¡${r} vuela como yo!`,
  (r: string) => `¡Qué pinche nivel, ${r}!`,
  (r: string) => `¡${r} en vivo y ni un error!`,
  (r: string) => `¡Viernes de deploy y ${r} ni tembló!`,
];
/**
 * Arcade: de vez en cuando, al terminar de caminar, aparece una maquinita junto
 * a él y se pone a jugar. Gana -> marometas y gritos. Pierde -> le mienta la
 * madre a la máquina, la patea, la máquina echa humo y truena, y se desquita
 * con quien está logueado. Aquí sí hay insultos: es la gracia de la escena.
 */
type FaseMaquina = "jugando" | "gana" | "pierde" | "patada" | "rota";
type Maquina = { id: number; x: number; y: number; fase: FaseMaquina; saliendo?: boolean };
const ARCADE_JUGAR_MS: [number, number] = [7000, 10_000];
const ARCADE_GANA_MS = 6000;
const ARCADE_BERRINCHE_MS = 4800;
const ARCADE_PATADA_MS = 900;
const ARCADE_ENCABRONADO_MS = 7000;
/** Cada cuánto le dan ganas de jugar (la primera vez, más pronto). */
const ARCADE_CADA_MS: [number, number] = [120_000, 240_000];
/** Para probar la escena desde la consola: `dispatchEvent(new CustomEvent("agente:arcade", { detail: { gana: false } }))`. */
export const EVENTO_ARCADE = "agente:arcade";
const MAQUINA_ANCHO = 54;
const MAQUINA_ALTO = 86;
/** Dónde quedan los pies dentro del cuadro de 80px (el sprite pisa al 92%). */
const PIES = 74;
const FRASES_ARCADE = {
  empezar: [
    "¡Una retita y regreso a trabajar!", "¡Hoy sí rompo el récord!", "Nomás una fichita…",
    "¡Récord mundial, ahí te voy!", "Shhh… nadie le diga al jefe",
  ],
  jugando: [
    "¡Dale, dale, dale!", "¡Brinca, pendejo, brinca!", "¡Ese jefe es mío!", "¡Combo, combo, combo!",
    "¡Uy, casi!", "¡No me distraigan!", "Arriba, arriba, abajo, abajo…", "¡Esquiva, esquiva!",
  ],
  gana: [
    "¡A HUEVO, GANÉ!", "¡Soy el puto amo del arcade!", "¡Récord mundial, cabrones!", "¡Nadie me para!",
    "¡Toma, maquinita, de rodillas!", "¡Al salón de la fama, perros!", "¡GAME OVER pa' ti, máquina!",
  ],
  madre: [
    "¡Chinga tu madre, maquinita!", "¡Tu pinche madre, me hiciste trampa!", "¡Me robaste la ficha, rata!",
    "¡Ese botón no sirve, a la verga!", "¡Máquina tramposa, hija de tu…!", "¡Tu madre es una tostadora!",
    "¡Pinche joystick chueco de mierda!",
  ],
  patada: ["¡Toma, pinche máquina!", "¡Pa' que aprendas, cabrona!", "¡Ahí te va tu patadón!"],
  rota: ["¡Y encima se descompuso!", "¡Ahora humea, no mames!", "¡Ya ni sirves pa' chatarra!"],
  usuario: [
    (n: string) => `¡${n}, tú me echaste la sal, cabrón!`,
    (n: string) => `¿Y tú qué me ves, ${n}? ¡Ponte a jalar!`,
    (n: string) => `¡${n}, pinche salado, ya la descompusiste!`,
    (n: string) => `¡Esto es tu culpa, ${n}! ¡Tú la conectaste!`,
    (n: string) => `¡${n}, me debes una ficha y una máquina!`,
    (n: string) => `¡No te rías, ${n}, que te pateo a ti también!`,
    (n: string) => `¡${n}, tu pinche wifi me hizo perder!`,
    (n: string) => `¡Lárgate a tus tickets, ${n}, pendejo!`,
  ],
} as const;

/**
 * Pesca: al terminar de caminar, a veces aparece un charquito enfrente y se
 * pone a pescar (1 a 3 lances). Saca tickets y PRs y los presume; de vez en
 * cuando un pez escurridizo que cae al suelo, se le escapa brincando y lo
 * persigue sin alcanzarlo. El charco, la caña y lo que saca van en un portal
 * fijo dibujado como si mirara a la derecha (se voltea entero si mira a la izquierda).
 */
/** `adelante`: el pez cae pasando el charco (si no, detrás de él). */
type Presa = { tipo: "ticket" | "pr" | "pez"; num: number; adelante?: boolean };
type FasePesca = "esperando" | "jalando" | "presume" | "persecucion";
type Pesca = {
  id: number; x: number; y: number; dir: 1 | -1; fase: FasePesca; presa: Presa | null; lance: number;
  /** Dónde arranca el pez que se escapa (luego lo mueve el loop). */
  pez?: { x: number; y: number; dir: 1 | -1 };
  saliendo?: boolean;
};
/** Para probarla: `dispatchEvent(new CustomEvent("agente:pesca", { detail: { pez: true } }))`. */
export const EVENTO_PESCA = "agente:pesca";
/** Caja del dibujo: el personaje ocupa 0-80 y el charco queda adelante. */
const PESCA_ANCHO = 190;
/** Lo que sobra arriba del personaje para la punta de la caña. */
const PESCA_ARRIBA = 30;
const PESCA_ESPERA_MS: [number, number] = [3500, 7000];
const PESCA_JALAR_MS = 1000;
const PESCA_PRESUME_MS = 3200;
const PESCA_CORAJE_MS = 3600;
const PESCA_CADA_MS: [number, number] = [150_000, 300_000];
const VEL_PERSEGUIR = 150;
const VEL_PEZ = 190;
const FRASES_PESCA = {
  empezar: [
    "Ahorita vengo, voy a pescar bugs", "A ver qué pica hoy…", "Pesca de viernes, la mejor",
    "Shhh, que se espantan los PRs",
  ],
  esperando: [
    "Shhh…", "Pícale, pícale…", "Aquí salen puros tickets, ya verás", "…¿y si pica un hotfix?",
    "Zzz… ¡no, no estoy dormido!", "Este charco huele a legacy",
  ],
  pica: ["¡Picó, picó!", "¡Ya cayó uno!", "¡Está pesado, cabrón!"],
  ticket: [
    (n: number) => `¡Un ticket #${n}! …lo devuelvo al agua`,
    (n: number) => `¿#${n}? Ese ni es mío`,
    (n: number) => `¡Ticket #${n}, alta prioridad, a huevo!`,
    (n: number) => `#${n}… otro que era para ayer`,
  ],
  pr: [
    (n: number) => `¡PR #${n}! ¿Quién lo aprueba?`,
    (n: number) => `¡PR #${n} con conflictos, no mames!`,
    (n: number) => `PR #${n}… sin tests, al agua`,
    (n: number) => `¡PR #${n} directo a main!`,
  ],
  escapa: ["¡Ey, ey, EY! ¡Se escapa!", "¡Regresa, pinche pez!", "¡No, no, no, no!"],
  persigue: ["¡Ven acá, cabrón!", "¡Pinche pez escurridizo!", "¡No corras, que te frío!", "¡Tengo hambre, regresa!", "¡Agárrenlo!"],
  seFue: [
    "¡Se me peló el cabrón!", "Ni modo… hoy cenamos tickets", "¡Ese pez es más rápido que el CI!",
    "La próxima te agarro, maldito", "¡Pinche pez, me las vas a pagar!",
  ],
};

/**
 * Café: al terminar de caminar, a veces aparece un kiosquito de MONÓCOLO
 * (café de especialidad de Guadalajara, monocolo.mx; sus colores: espresso,
 * crema y dorado). Se va a chingar un cafecito, pide por la app (viñeta del
 * celular), le brota un bug cabrón en la pantalla y se imagina a Toñito
 * echando la weba, dando un rol en su moto (globo de pensamiento).
 */
type FaseCafe = "rumbo" | "llega" | "app" | "bug" | "tonito";
/** `x`,`y`: el kiosco; `pj`: dónde quedó parado el personaje (para la viñeta y el globo). */
type Cafe = { id: number; x: number; y: number; fase: FaseCafe; pj: { x: number; y: number }; saliendo?: boolean };
/** Para probarla: `dispatchEvent(new CustomEvent("agente:cafe"))`. */
export const EVENTO_CAFE = "agente:cafe";
/** Kiosco: ancho de su dibujo y lo que sobresale arriba del personaje. */
const CAFE_ANCHO = 88;
const CAFE_ARRIBA = 30;
/** Aparece lejos, del lado contrario, y él camina hasta allá (no más de esto). */
const CAFE_LEJOS = 420;
const CAFE_MS: Record<Exclude<FaseCafe, "rumbo">, number> = { llega: 1800, app: 4200, bug: 2800, tonito: 6500 };
const CAFE_CADA_MS: [number, number] = [180_000, 360_000];
const FRASES_CAFE = {
  rumbo: ["¡Me voy a ir a chingar un cafecito!", "Ya estuvo, un cafecito o me muero", "¡Monócolo, ahí te voy!"],
  llega: ["¡Quiubo! …mejor lo pido en la app", "Huele a gloria aquí", "A ver el menú…"],
  app: [
    "Un latte de avena… extra shot", "Pidiendo por la app, como la gente decente", "Un cold brew pa' aguantar el deploy",
    "Con puntos me sale gratis, ¿no?",
  ],
  bug: ["¡¿Qué?! ¡Un bug cabrón!", "¡No mames, un bug en la app!", "¡Me lleva la…! ¡Un bug!"],
  tonito: [
    "¡Mta madre! ¿Ese Toñito qué estará haciendo?", "¿Y el Toñito? Seguro echando la weba…",
    "¡Toñooo! ¿Dónde andas, cabrón?", "Ese Toñito ha de andar dando el rol…",
  ],
};

/**
 * Escenas con guion (utilería en escenasExtra.tsx): una lista de pasos, cada
 * uno con su pose, duración, frases y lo que muestra la utilería. Las arranca
 * el loop al terminar de caminar (como el arcade), salvo el viernes de deploy,
 * que llega por evento cuando arranca un deploy a PRD en viernes en la tarde
 * o en fin de semana.
 */
type Extra = "elotero" | "junta" | "stack" | "wifi" | "campamento"
  | "pato" | "review" | "tanda" | "merge" | "derrame" | "nube" | "becario" | "lunes" | "futbol" | "pinata";
const EXTRAS: Extra[] = [
  "elotero", "junta", "stack", "wifi", "campamento", "pato", "review", "tanda", "merge", "derrame", "nube", "becario", "lunes", "futbol", "pinata",
];
/** Las que solo salen ciertos días (el resto, siempre). */
const DISPONIBLE: Partial<Record<Extra, () => boolean>> = {
  lunes: () => { const d = new Date(); return d.getDay() === 1 && d.getHours() < 12; },
  futbol: () => !!partidoDeHoy(),
};
/** Cada cuánto, si no es la general: el día del partido, seguido. */
const CADA_EXTRA: Partial<Record<Extra, () => [number, number]>> = {
  futbol: () => (partidoEnVivo() ? [90_000, 180_000] : [600_000, 900_000]),
  lunes: () => [1_200_000, 2_400_000],
};
/** Para probarlas: `dispatchEvent(new CustomEvent("agente:escena", { detail: { escena: "campamento" } }))` (o "viernes"). */
export const EVENTO_ESCENA = "agente:escena";
const EXTRA_CADA_MS: [number, number] = [240_000, 480_000];
/** Viernes después de las 5 pm o fin de semana: deployar es pecado. */
const esViernesTarde = (d = new Date()) => d.getDay() === 6 || d.getDay() === 0 || (d.getDay() === 5 && d.getHours() >= 17);
const FRASES_VIERNES = {
  rezo: [
    (r: string) => `San Rollback, que no truene ${r}…`, () => "Prometo escribir tests, lo juro", () => "Diosito, que pase el CI",
    () => "Ave María purísima, sin conflictos", () => "Si sale bien, dejo de hacer push a main", (r: string) => `Virgencita, cuida a ${r}`,
  ],
  ok: [(r: string) => `¡MILAGRO! ${r} pasó en viernes`, () => "¡San Rollback nos escuchó!", () => "¡Gracias, Diosito, no lo vuelvo a hacer!"],
  fallo: [(r: string) => `¡LES DIJE! ${r} en viernes, no`, () => "¡En viernes no se deploya, chingao!", () => "San Rollback nos abandonó…"],
};
const FRASES_GUION = {
  eloteroLlega: ["¿Eso es…? ¡El elotero!", "¡Escucho la trompetita!"],
  eloteroPide: ["¡Uno con todo, mayonesa y chile del que pica!", "¡Un esquite grande con todo, jefe!"],
  eloteroCome: ["Ñam… ñam…", "Está buenísimo…", "Mmm, con limoncito"],
  enchilado: ["¡¡AGUA, AGUA, AGUA!!", "¡ME ENCHILÉ, CABRÓN!", "¡Siento la lengua en el sol!", "¡¿Qué chile era ese?!"],
  junta: ["Bueno, ¿sí se escucha? …ok, empiecen", "Junta de 1 h 30… pudo ser un correo"],
  juntaDuerme: ["Z z z", "…mjm… sí… zzz", "Zzz… deploy… zzz"],
  juntaDespierta: ["¡Sí, sí, de acuerdo, totalmente!", "¡Claro! …exacto, lo que dijo él"],
  juntaFin: ["…¿de qué estábamos hablando?", "¿Ya se acabó? ¿Me perdí de algo?"],
  stackLee: ["A ver… ¿cómo se centra un div?", "Nomás copio esta respuesta…"],
  stackCae: ["¡¿QUÉ?! ¡¿Stack Overflow caído?!", "¡No, no, no! ¡Stack Overflow no!"],
  stackCrisis: ["¿Y ahora cómo programo?", "¡Me voy a tener que leer la documentación!", "¡NO SÉ HACER NADA SOLO!"],
  stackSolo: ["…¿for o while?", "¿Qué es un for?", "…console.log('ayuda')"],
  stackFin: ["Oye GeorgIA… ah no, soy yo 😐", "¿Y si le pregunto a Claude?"],
  patoExplica: [
    "Mira, patito: el bug es que…", "…entonces el useEffect se llama dos veces…", "…y la variable llega undefined porque…",
    "…y el await está adentro del forEach…",
  ],
  patoFoco: ["¡¡YA SÉ QUÉ ES!!", "¡¡ERA EL AWAIT, NO MAMES!!"],
  patoGracias: ["¡Gracias, patito! Eres el mejor senior", "¡Otro bug resuelto por el pato!"],
  review: ["A ver qué dice el review…", "…okay…", "¿Nit otra vez?", "¡Es un espacio, carnal!", "Me siento chiquito…"],
  reviewFin: ["¿Changes requested? Snif…", "Y yo que lo iba a mergear hoy…"],
  tanda: ["¡Llegó el día de la tanda, raza!", "Ahora sí, a juntar la lana"],
  tandaCuenta: ["Mil… dos mil… tres mil…", "¿Quién no ha pagado?", "Este billete está roto, ¿eh?"],
  tandaHuye: ["¡Se fue con todo!", "¡Era para mis vacaciones!", "¡Nunca más hago tanda!", "¡Bloquéenlo en el Slack!"],
  merge: ["¡Suelta mi capa, versión de HEAD!", "<<<<<<< HEAD", "¡Mi cambio va primero!", "¡Yo llegué antes!"],
  mergeSepara: ["¿Los dos? …¡ah, pues sí!", "Ok, ok… aceptamos ambos"],
  mergeOk: ["¡Merge exitoso!", "¡Cero conflictos, a huevo!"],
  derrame: ["Un cafecito pa' la laptop… digo, pa' mí", "Con cuidadito…"],
  derrameCae: ["¡Ay, ay, AY!", "¡Nooo!"],
  derrameChispa: ["¡¡LA LAPTOP!!", "¡¡MIS COMMITS!!"],
  derrameAbanica: ["¡Sóplale, sóplale!", "¡No te mueras, tenía todo sin commit!", "¿Arroz? ¿Alguien tiene arroz?"],
  nube: ["¡Nos mudamos a la nube, raza!", "Adiós, servidores físicos…", "¡Qué moderno, qué escalable!"],
  nubeFactura: ["¡¿48 MIL DÓLARES?!", "¡¿Quién dejó prendidas las instancias?!"],
  nubeCae: ["¡Me lleva! ¡Regresamos on-premise!", "¡AAAAAH!"],
  becario: ["¿Y tú quién eres?", "¿Me estás copiando?"],
  becarioCorre: ["¡Ni se te ocurra tocar eso!", "¡No, no, por ahí no!"],
  becarioTumba: ["¡¡TUMBASTE PROD!!", "¡¿Quién contrató a este becario?!", "¡Rollback, rollback!", "¡Que alguien llame a Infra!"],
  lunes: ["Luuuunes…", "No me hablen hasta el tercer café", "¿Ya es viernes?", "Cinco minutitos más…"],
  futbolPrevia: ["¡No me agenden juntas!", "¡Ya compré las chelas!", "¡Este año sí!"],
  futbolVivo: ["¡Pásala, pásala!", "¡Ese árbitro está comprado!", "¡Tírale, tírale!", "¡Ándale, cabrones!"],
  futbolGol: ["¡GOOOOOOL DE MÉXICO!", "¡Cielito lindo, a huevo!", "¡GOL, GOL, GOOOL!"],
  futbolFalla: ["¡¿CÓMO LA FALLAS?!", "¡Mi abuelita la mete!", "Jugamos como nunca, perdimos como siempre…"],
  pinata: ["¡Dale, dale, dale, no pierdas el tino!", "¿Dónde está? ¡Ahí voy!"],
  pinataGolpe: ["¡Uno!", "¡Dos!", "¡¡TRES!!"],
  pinataRota: ["¡Tickets cerrados, raza!", "¡Agarren los suyos!", "¡Puro ✅!"],
  wifiLag: ["¿Por… qué… va… todo… lento…?", "Se… me… congeló… todo…"],
  wifiSenal: ["¡Ven, señal, ven!", "Una rayita… dos…", "¡Más arriba!", "Si me muevo se va…"],
  wifiOk: ["¡Ya agarró, a huevo!", "¡Tres rayitas, no mames!"],
  fogata: ["Ahh… qué paz, sin tickets ni deploys", "Esto sí es vida: cero Slack"],
  oso: ["¿Eh…? ¿Qué es ese ruido?", "…¿quién anda ahí?"],
  osoRoba: ["¡¡OIGA, MI COBIJA!!", "¡¿Qué hace, oso cabrón?!"],
  osoPersigue: ["¡Regrésamela, oso cabrón!", "¡Era de Liverpool!", "¡Hace un frío del carajo!", "¡Párate, ratero peludo!"],
  osoCubre: ["¡No me vean, no me vean!", "…ni modo, en calzones", "¡Esto no sale del dashboard!", "¡Qué oso! …literal"],
};

/** En viernes en la tarde (o fin de semana), el resultado del deploy se festeja como milagro o se reclama. */
const fraseDeploy = (r: string) => (esViernesTarde() && Math.random() < 0.6 ? una(FRASES_VIERNES.ok)(r) : una(FRASES_DEPLOY)(r));
const fraseFallo = (r: string) => (esViernesTarde() && Math.random() < 0.6 ? una(FRASES_VIERNES.fallo)(r) : una(FRASES_FALLO)(r));

const signoAzar = () => (Math.random() < 0.5 ? -1 : 1) as 1 | -1;
const una = <T,>(l: readonly T[]): T => l[Math.floor(Math.random() * l.length)];

interface Props {
  /** El chat está abierto: el personaje se queda quieto donde está. */
  pausado: boolean;
  /** Nombre de quien está logueado (para que el personaje se desquite con él). */
  nombreUsuario: string;
  /**
   * `motivo` = "tickets" si se le dio clic mientras gritaba la alerta; "avisos"
   * (con la conversación y dónde está quien lo trajo, para abrir ahí la
   * ventanita) si fue mientras le traían un aviso.
   */
  onClick: (motivo: "chat" | "tickets" | "avisos", convId?: string, donde?: DOMRect) => void;
  /** Permiso «Voz del avatar»: dice en voz alta lo que pone en sus globos. */
  voz?: boolean;
}

const TAM = 80;
const MARGEN = 8;
/** Espacio bajo los pies para el gafete, con holgura: en algunas pantallas el borde inferior del viewport queda tapado. */
const GAFETE = 28;
/** Alto del header sticky: no vuela por encima de la navegación. */
const TECHO = 64;
const VEL_VUELO: [number, number] = [150, 230];
const VEL_CAMINAR = 48;

const azar = (a: number, b: number) => a + Math.random() * (b - a);

export function AgenteVolador({ pausado, nombreUsuario, onClick, voz = false }: Props) {
  const raiz = useRef<HTMLButtonElement>(null);
  const orientacion = useRef<HTMLDivElement>(null);
  const inclinacion = useRef<HTMLDivElement>(null);
  // Con movimiento reducido arranca (y se queda) de pie.
  const [pose, setPose] = useState<Pose>(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "quieto" : "volar",
  );
  const [pausaLocal, setPausaLocal] = useState(false);
  // El avatar cambia según el ticket (quien lo levantó) o la elección de cada quien: el gafete dice quién es.
  const skin = useSkinGeorgIA();
  const nombre = useNombresAvatar()(skin);
  const [animo, setAnimo] = useState<Animo>("feliz");
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [letrero, setLetrero] = useState<Letrero | null>(null);
  const [snack, setSnack] = useState<Snack | null>(null);
  const [vuelo, setVuelo] = useState<EstiloVuelo>("superman");
  const [manga, setManga] = useState<Manga | null>(null);
  const [maquina, setMaquina] = useState<Maquina | null>(null);
  const [pesca, setPesca] = useState<Pesca | null>(null);
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [utileria, setUtileria] = useState<Utileria | null>(null);
  /** El elotero o el oso: lo mueve el loop directo. */
  const actorRef = useRef<HTMLDivElement>(null);
  /** El oso se llevó la cobija: anda en calzones. */
  const [calzones, setCalzones] = useState(false);
  /** Wi-Fi caído: gris y trabado. */
  const [lag, setLag] = useState(false);
  const [enMano, setEnMano] = useState<"elote" | "cafe" | "termo" | "bandera" | "palo" | null>(null);
  /** Encima de la cabeza o la cara: el foco de la idea o la venda de la piñata. */
  const [extra, setExtra] = useState<"foco" | "venda" | null>(null);
  /** Avisos: antes del mensaje, «¡te buscan!» (signo y ondas) sobre el propio. */
  const [llamando, setLlamando] = useState(false);
  /** Avisos: el avatar de quien manda entra desde una orilla y lo grita. */
  const [mensajero, setMensajero] = useState<(AvisoParaAvatar & { x: number; y: number; lado: "izq" | "der"; fase: "entra" | "grita" | "sale" }) | null>(null);
  // Avatares que son usuarios (con correo): los socios de la tanda.
  const correosAvatar = useCorreosAvatar();
  const usuariosRef = useRef<{ skin: Skin; nombre: string }[]>([]);
  useEffect(() => {
    usuariosRef.current = SKINS.filter((x) => correosAvatar[x.id]).map((x) => ({ skin: x.id, nombre: nombreAvatar(x.id) }));
  }, [correosAvatar]);
  const vozRef = useRef(voz);
  useEffect(() => {
    vozRef.current = voz;
    if (!voz && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, [voz]);
  const skinRef = useRef(skin);
  useEffect(() => {
    skinRef.current = skin;
  }, [skin]);
  /** El pez que se escapa lo mueve el loop directo (como al personaje), sin re-render por frame. */
  const pezRef = useRef<HTMLDivElement>(null);
  /** Lo último que se pintó de la pesca, para que el loop sepa qué presa salió y dónde está la caja. */
  const pescaRef = useRef<Pesca | null>(null);
  useEffect(() => {
    pescaRef.current = pesca;
  }, [pesca]);
  const pausaRef = useRef(false);
  // Calendario de la Selección (lo deja el sync mensual en Firestore).
  useEffect(() => {
    cargarPartidosSeleccion().then(setPartidosSeleccion).catch(() => {});
  }, []);
  const nombreRef = useRef(nombreUsuario);
  useEffect(() => {
    nombreRef.current = nombreUsuario;
  }, [nombreUsuario]);
  /** Hay alerta de tickets activa (el clic abre la pestaña de tickets y la apaga). */
  const alertaRef = useRef<{ apagar: () => void; motivo?: "chat" | "tickets" | "avisos"; convId?: string } | null>(null);
  useEffect(() => {
    pausaRef.current = pausado || pausaLocal;
  }, [pausado, pausaLocal]);

  useEffect(() => {
    const el = raiz.current;
    if (!el) return;
    const reducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const piso = () => window.innerHeight - TAM - MARGEN - GAFETE;
    const derecha = () => window.innerWidth - TAM - MARGEN;

    if (reducido) {
      // Sin huracán ni confeti: solo el grito.
      const reaccion = (tipo: Letrero["tipo"]) => (e: Event) => {
        const d = (e as CustomEvent<DetalleFestejo>).detail ?? { repo: "el repo" };
        setAnimo(tipo === "exito" ? "feliz" : "llorando");
        setLetrero({
          tipo,
          id: Date.now(),
          titulo: `${tipo === "exito" ? "✅ Deploy exitoso a PRD" : "❌ Falló el deploy a PRD"} · ${dondeFue(d)}`,
          linea: una(tipo === "exito" ? FRASES_DEPLOY : FRASES_FALLO)(d.repo),
        });
        setTimeout(() => setLetrero(null), 9000);
      };
      const alFestejo = reaccion("exito");
      const alFallo = reaccion("fallo");
      window.addEventListener(EVENTO_FESTEJO, alFestejo);
      window.addEventListener(EVENTO_FALLO, alFallo);
      const alAlertaQuieto = (e: Event) => {
        const gritos = (e as CustomEvent<DetalleAlerta>).detail?.gritos ?? [];
        if (!gritos.length) return;
        alertaRef.current = { apagar: () => setDialogo(null) };
        setAnimo("grito");
        setDialogo({ id: Date.now(), texto: gritos[0], tipo: "grito" });
      };
      window.addEventListener(EVENTO_ALERTA_TICKETS, alAlertaQuieto);
      // Sin movimiento: solo el letrero de Claude.
      const alClaudeQuieto = (e: Event) => {
        const c = (e as CustomEvent<DetalleClaude>).detail;
        if (!c) return;
        alertaRef.current = { apagar: () => setLetrero(null) };
        setAnimo(c.resultado === "fallo" ? "llorando" : c.resultado === "ok" ? "feliz" : "serio");
        setLetrero({
          tipo: c.resultado === "ok" ? "claude" : c.resultado === "pregunta" ? "claude-pregunta" : "claude-fallo",
          id: Date.now(),
          titulo: c.resultado === "ok" ? `🤖 Claude terminó ${c.folio}` : c.resultado === "pregunta" ? `❓ Claude te pregunta algo · ${c.folio}` : `💥 Claude falló en ${c.folio}`,
          linea: una(c.resultado === "ok" ? FRASES_CLAUDE_OK : c.resultado === "pregunta" ? FRASES_CLAUDE_PREGUNTA : FRASES_CLAUDE_FALLO)(c.nombre),
        });
        if (c.resultado !== "pregunta") setTimeout(() => setLetrero(null), 9000);
      };
      window.addEventListener(EVENTO_CLAUDE, alClaudeQuieto);
      const colocar = () => { el.style.transform = `translate3d(${MARGEN + 8}px, ${piso()}px, 0)`; };
      colocar();
      window.addEventListener("resize", colocar);
      return () => {
        window.removeEventListener("resize", colocar);
        window.removeEventListener(EVENTO_FESTEJO, alFestejo);
        window.removeEventListener(EVENTO_FALLO, alFallo);
        window.removeEventListener(EVENTO_ALERTA_TICKETS, alAlertaQuieto);
        window.removeEventListener(EVENTO_CLAUDE, alClaudeQuieto);
      };
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
      // Deploys por reaccionar (llegan por evento): festejo o llanto, en fila.
      festejos: [] as (DetalleFestejo & {
        tipo: Letrero["tipo"] | "dev-ok" | "dev-fallo" | "store-ok" | "store-fallo" | "claude-ok" | "viernes";
        store?: DetalleStore;
        claude?: DetalleClaude;
      })[],
      festejoRepo: "",
      festejoInicio: 0,
      festejoTheta: 0,
      alertaGritos: [] as string[],
      alertaHasta: 0,
      /** Duración de la próxima alerta (la de un aviso la termina el mensajero); 0 = ALERTA_MS. */
      alertaDur: 0,
      /** La alerta en curso es un aviso (la grita el mensajero, no el propio). */
      megafono: false,
      /** El clic atendió la escena de Claude: se corta al volver. */
      cortarEscena: false,
      alertaIdx: 0,
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
    let escenaStore: DetalleStore | null = null;
    let escenaClaude: DetalleClaude | null = null;
    let idDialogo = 0;
    let idLetrero = 0;
    // Al terminar la escena el letrero se queda unos segundos más, quieto, para
    // que se alcance a leer la última frase (antes se iba junto con la escena).
    let quitarLetrero: ReturnType<typeof setTimeout> | undefined;
    const soltarLetrero = () => {
      const id = idLetrero;
      clearTimeout(quitarLetrero);
      quitarLetrero = setTimeout(() => setLetrero((l) => (l && l.id === id ? null : l)), LETRERO_EXTRA_MS);
    };
    let finDialogo = 0;
    let llamadaHasta = 0;
    // Avisos: uno a la vez; los que llegan mientras tanto esperan su turno.
    const colaAvisos: AvisoParaAvatar[] = [];
    let avisoActual: AvisoParaAvatar | null = null;
    let audioAviso: HTMLAudioElement | null = null;
    let faseMensajero: "entra" | "grita" | "sale" | null = null;
    let faseHasta = 0;
    const terminarAviso = () => {
      audioAviso?.pause();
      audioAviso = null;
      callarVoz(0);
      avisoActual = null;
      faseMensajero = null;
      s.megafono = false;
      s.alertaGritos = [];
      llamadaHasta = 0;
      setLlamando(false);
      setMensajero(null);
    };
    const tomarAviso = () => {
      if (avisoActual || !colaAvisos.length || s.alertaGritos.length) return;
      const a = colaAvisos.shift()!;
      avisoActual = a;
      audioAviso = a.audio && !a.recordatorio ? audioDeAviso(a.audio) : null;
      // Marcador: la pose «alerta» sigue mientras dure el aviso (la termina el mensajero).
      s.alertaGritos = ["…"];
      s.alertaDur = 10 * 60_000;
      s.megafono = true;
      alertaRef.current = { apagar: terminarAviso, motivo: "avisos", convId: a.convId };
    };
    let proximaFrase = performance.now() + azar(1500, 4000);
    /** `voz`: decirlo en voz alta; por defecto, si la persona tiene la voz prendida. */
    const decir = (texto: string, tipo: Dialogo["tipo"] = "habla", ms = 2400, voz = vozRef.current) => {
      idDialogo += 1;
      finDialogo = performance.now() + ms;
      setDialogo({ id: idDialogo, texto, tipo });
      if (voz && tipo !== "zzz" && !pausaRef.current) hablar(texto, skinRef.current);
    };

    let snackActual: Snack | null = null;
    // La viñeta del antojo se lanza en el siguiente frame (lanzarManga se define después).
    let lanzarMangaPendiente: Snack | null = null;
    const ponerSnack = (x: Snack | null) => {
      if (x !== snackActual) {
        snackActual = x;
        setSnack(x);
      }
    };
    let proximoHelado = performance.now() + azar(15_000, 30_000);
    let estiloActual: EstiloVuelo = "superman";
    let proximoEstilo = performance.now() + azar(8000, 14_000);
    const ponerEstilo = (e: EstiloVuelo) => {
      if (e !== estiloActual) {
        estiloActual = e;
        setVuelo(e);
      }
    };
    const crucero = () => (estiloActual === "relax" ? 110 : estiloActual === "nado" ? 140 : 190);
    let idManga = 0;
    let finManga = 0;
    // También en pleno vuelo, cada 15-30 s (antes solo descansando o tras un golpe).
    let proximaMangaVuelo = performance.now() + azar(10_000, 20_000);
    const lanzarManga = (v: Viñeta) => {
      idManga += 1;
      finManga = performance.now() + MANGA_MS;
      setManga({ ...v, id: idManga, x: s.x, y: s.y });
    };
    let heladoHasta = 0;

    // Arcade (ver FRASES_ARCADE): la máquina vive aparte del personaje (portal fijo).
    let proximoArcade = performance.now() + azar(60_000, 120_000);
    let arcade: { gana: boolean; encabronado: boolean } | null = null;
    /** Resultado forzado por EVENTO_ARCADE (pruebas). */
    let arcadeForzado: boolean | null = null;
    let idMaquina = 0;
    let quitarMaquina: ReturnType<typeof setTimeout> | undefined;
    const faseMaquina = (fase: FaseMaquina) => setMaquina((m) => (m ? { ...m, fase } : m));
    /** Se pone a jugar si cabe la máquina enfrente (hacia donde haya lugar). */
    const empezarArcade = (ahora: number): boolean => {
      const cabeDer = s.x + 56 + MAQUINA_ANCHO <= window.innerWidth - MARGEN;
      const cabeIzq = s.x - 30 >= MARGEN;
      if (!cabeDer && !cabeIzq) return false;
      s.dir = (cabeDer && (!cabeIzq || Math.random() < 0.5) ? 1 : -1) as 1 | -1;
      s.y = piso();
      arcade = { gana: arcadeForzado ?? Math.random() < 0.5, encabronado: false };
      arcadeForzado = null;
      clearTimeout(quitarMaquina);
      idMaquina += 1;
      setMaquina({
        id: idMaquina,
        x: s.dir === 1 ? s.x + 56 : s.x - 30,
        y: piso() + PIES - MAQUINA_ALTO,
        fase: "jugando",
      });
      cambiarPose("arcade", azar(...ARCADE_JUGAR_MS));
      ponerAnimo("serio");
      decir(una(FRASES_ARCADE.empezar), "habla", 2400);
      proximaFrase = ahora + 3200;
      return true;
    };
    // Pesca (ver FRASES_PESCA).
    let proximaPesca = performance.now() + azar(90_000, 180_000);
    let pezForzado = false;
    let pescaJs: { lances: number; n: number; forzarPez: boolean; pez: { x: number; y: number; dir: 1 | -1 } | null } | null = null;
    let idPesca = 0;
    let quitarPesca: ReturnType<typeof setTimeout> | undefined;
    const cambiarPesca = (c: Partial<Pesca>) => setPesca((p) => (p ? { ...p, ...c } : p));
    const empezarPesca = (ahora: number, forzarPez: boolean): boolean => {
      const cabeDer = s.x + PESCA_ANCHO <= window.innerWidth - MARGEN;
      const cabeIzq = s.x + TAM - PESCA_ANCHO >= MARGEN;
      if (!cabeDer && !cabeIzq) return false;
      s.dir = (cabeDer && (!cabeIzq || Math.random() < 0.5) ? 1 : -1) as 1 | -1;
      s.y = piso();
      pescaJs = { lances: 1 + Math.floor(Math.random() * 3), n: 0, forzarPez, pez: null };
      clearTimeout(quitarPesca);
      idPesca += 1;
      setPesca({
        id: idPesca,
        x: s.dir === 1 ? s.x : s.x + TAM - PESCA_ANCHO,
        y: piso() - PESCA_ARRIBA,
        dir: s.dir,
        fase: "esperando",
        presa: null,
        lance: 0,
      });
      cambiarPose("pescar", azar(...PESCA_ESPERA_MS));
      ponerAnimo("relajado");
      decir(una(FRASES_PESCA.empezar), "habla", 2400);
      proximaFrase = ahora + 3000;
      return true;
    };
    // ── Escenas con guion ─────────────────────────────────────────────────────
    type PasoGuion = {
      pose: Pose;
      /** Sin `ms`, el paso dura hasta que `mover` diga que ya terminó. */
      ms?: number;
      fase?: string;
      animo?: Animo;
      decir?: () => string;
      tipo?: Dialogo["tipo"];
      /** Cuánto se queda el globo de `decir` (por omisión 2.4 s). */
      dura?: number;
      frases?: () => string;
      tipoFrases?: Dialogo["tipo"];
      cada?: number;
      al?: () => void;
      mover?: (dt: number, ahora: number) => boolean;
      /** Se queda en el aire (la nube): no lo baja al piso. */
      aire?: boolean;
    };
    let guion: { pasos: PasoGuion[]; i: number; hasta: number; prox: number; fin?: () => void } | null = null;
    let quitarUtileria: ReturnType<typeof setTimeout> | undefined;
    let quitarCalzones: ReturnType<typeof setTimeout> | undefined;
    let idUtileria = 0;
    let actor: { x: number; y: number; dir: 1 | -1 } | null = null;
    const proxExtra = Object.fromEntries(EXTRAS.map((e) => [e, performance.now() + azar(180_000, 420_000)])) as Record<Extra, number>;
    // El lunes en la mañana y el día del partido, de entrada.
    proxExtra.lunes = performance.now() + azar(20_000, 60_000);
    proxExtra.futbol = performance.now() + azar(30_000, 90_000);
    let extraForzada: Extra | null = null;
    const enEscena = () => ESCENAS.includes(s.pose) || !!guion;
    const pintarActor = () => {
      if (actor && actorRef.current) {
        actorRef.current.style.transform = `translate3d(${actor.x.toFixed(1)}px, ${actor.y}px, 0)`;
        const cuerpo = actorRef.current.firstElementChild as HTMLElement | null;
        if (cuerpo) cuerpo.style.transform = `scaleX(${actor.dir})`;
      }
    };
    const faseUtileria = (fase: string) => setUtileria((u) => (u ? { ...u, fase } : u));
    const iniciarPaso = (ahora: number) => {
      if (!guion) return;
      const p = guion.pasos[guion.i];
      cambiarPose(p.pose);
      guion.hasta = p.ms ? ahora + p.ms : Infinity;
      if (p.fase) faseUtileria(p.fase);
      if (p.animo) ponerAnimo(p.animo);
      p.al?.();
      if (p.decir) {
        finDialogo = 0;
        decir(p.decir(), p.tipo ?? "grito", p.dura ?? 2400);
      }
      guion.prox = ahora + (p.decir ? (p.dura ?? 2400) + 300 : 600);
    };
    /**
     * Arranca un guion. Con `tipo`, pone la utilería enfrente de él (hacia donde
     * quepa, o hacia `dir`); sin lugar, no arranca.
     */
    const empezarGuion = (
      ahora: number, pasos: PasoGuion[], tipo: TipoUtileria | null,
      op: { dir?: 1 | -1; fin?: () => void; datos?: Partial<Utileria> } = {},
    ): boolean => {
      if (tipo) {
        const ancho = ANCHO_UTILERIA[tipo];
        const cabeDer = s.x + ancho <= window.innerWidth - MARGEN;
        const cabeIzq = s.x + TAM - ancho >= MARGEN;
        if (!cabeDer && !cabeIzq) return false;
        s.dir = op.dir ?? ((cabeDer && (!cabeIzq || Math.random() < 0.5) ? 1 : -1) as 1 | -1);
        if (s.dir === 1 && !cabeDer) s.dir = -1;
        if (s.dir === -1 && !cabeIzq) s.dir = 1;
        clearTimeout(quitarUtileria);
        idUtileria += 1;
        setUtileria({
          id: idUtileria,
          tipo,
          x: s.dir === 1 ? s.x : s.x + TAM - ancho,
          y: piso() - ARRIBA_UTILERIA,
          dir: s.dir,
          fase: pasos[0].fase ?? "",
          ...op.datos,
        });
      }
      actor = null;
      guion = { pasos, i: 0, hasta: 0, prox: 0, fin: op.fin };
      iniciarPaso(ahora);
      return true;
    };
    const terminarGuion = () => {
      const fin = guion?.fin;
      guion = null;
      actor = null;
      quitarUtileria = setTimeout(() => {
        setUtileria((u) => (u ? { ...u, saliendo: true } : u));
        quitarUtileria = setTimeout(() => setUtileria(null), 400);
      }, 250);
      fin?.();
      ponerAnimo("serio");
      cambiarPose("agachar", 200);
      s.siguiente = "despegar";
    };
    const correrGuion = (ahora: number, dt: number) => {
      if (!guion) return;
      const p = guion.pasos[guion.i];
      // Todo pasa en el piso: si venía volando, baja.
      if (!p.aire && s.y < piso()) s.y = Math.min(piso(), s.y + 520 * dt);
      const listo = p.mover ? p.mover(dt, ahora) : false;
      pintarActor();
      if (p.frases && !finDialogo && ahora >= guion.prox) {
        decir(p.frases(), p.tipoFrases ?? "habla", 2200);
        guion.prox = ahora + (p.cada ?? 3000);
      }
      if (listo || ahora >= guion.hasta) {
        guion.i += 1;
        if (guion.i >= guion.pasos.length) terminarGuion();
        else iniciarPaso(ahora);
      }
    };
    const unaF = (l: readonly string[]) => () => una(l);

    // Chistes: cada avatar los cuenta con su animación (personalidades.ts); en los
    // de dos, las líneas se contestan. Cada línea se queda según lo larga que sea.
    let proximoChiste = performance.now() + azar(20_000, 45_000);
    const contarChiste = (ahora: number): boolean => {
      const per = PERSONALIDAD[skinRef.current];
      if (!per?.chistes.length) return false;
      const lineas = una(per.chistes);
      const pasos: PasoGuion[] = lineas.map((l, i) => {
        const dura = Math.min(5200, 1600 + l.length * 45);
        return { pose: per.pose, ms: dura + 400, dura, decir: () => l, tipo: "habla", animo: i === lineas.length - 1 ? "feliz" : "serio" };
      });
      return empezarGuion(ahora, pasos, null);
    };
    /** Frase del avatar si tiene las suyas (la mitad de las veces), si no la general. */
    const fraseDe = (tipo: "caminar" | "aburrido", generales: readonly string[]) => {
      const propias = PERSONALIDAD[skinRef.current]?.[tipo];
      return propias?.length && Math.random() < 0.6 ? una(propias) : una(generales);
    };

    const escenaViernes = (ahora: number, repo: string): boolean => {
      idLetrero += 1;
      setLetrero({ tipo: "viernes", id: idLetrero, titulo: `🕯️ Deploy a PRD en ${new Date().getDay() === 5 ? "viernes" : "fin de semana"} · ${repo}`, linea: una(FRASES_VIERNES.rezo)(repo) });
      const pasos: PasoGuion[] = [{
        pose: "rezar", ms: 15_000, fase: "rezar", animo: "serio",
        frases: () => {
          const linea = una(FRASES_VIERNES.rezo)(repo);
          setLetrero((l) => (l && l.tipo === "viernes" ? { ...l, linea } : l));
          return linea;
        },
        cada: 3200,
      }];
      // Con lugar, la veladora enfrente; si no, reza igual.
      return empezarGuion(ahora, pasos, "veladora", { fin: soltarLetrero }) || empezarGuion(ahora, pasos, null, { fin: soltarLetrero });
    };

    const escenaElotero = (ahora: number): boolean => {
      const W = window.innerWidth;
      const dir = (s.x + TAM / 2 < W / 2 ? 1 : -1) as 1 | -1;
      const ANCHO_CARRITO = 70;
      const alto = piso() + 74 - 66;
      const desde = dir === 1 ? Math.min(W + 10, s.x + TAM + 450) : Math.max(-ANCHO_CARRITO - 10, s.x - 450 - ANCHO_CARRITO);
      const hasta = dir === 1 ? s.x + TAM - 6 : s.x + 6 - ANCHO_CARRITO;
      if (Math.abs(desde - hasta) < 120) return false;
      const pasos: PasoGuion[] = [
        {
          pose: "cafe", fase: "llega", animo: "feliz", decir: unaF(FRASES_GUION.eloteroLlega), tipo: "habla",
          al: () => {
            actor = { x: desde, y: alto, dir: (-dir) as 1 | -1 };
            setUtileria((u) => (u ? { ...u, actor: { ...actor! } } : u));
          },
          mover: (dt) => {
            if (!actor) return true;
            actor.x += 120 * dt * -dir;
            return dir === 1 ? actor.x <= hasta : actor.x >= hasta;
          },
        },
        { pose: "brinco", ms: 1900, fase: "para", decir: unaF(FRASES_GUION.eloteroPide) },
        { pose: "comer", ms: 3600, fase: "comer", animo: "comiendo", al: () => setEnMano("elote"), frases: unaF(FRASES_GUION.eloteroCome), cada: 1800 },
        {
          pose: "enchilado", ms: 3400, fase: "enchilado", animo: "grito", decir: unaF(FRASES_GUION.enchilado),
          frases: unaF(FRASES_GUION.enchilado), tipoFrases: "grito", cada: 1400,
        },
      ];
      return empezarGuion(ahora, pasos, "elotero", { dir, fin: () => setEnMano(null) });
    };

    const escenaJunta = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "sentado", ms: 3400, fase: "junta", animo: "aburrido", decir: unaF(FRASES_GUION.junta), tipo: "habla" },
      { pose: "cabeceo", ms: 6500, fase: "junta", animo: "dormido", frases: unaF(FRASES_GUION.juntaDuerme), tipoFrases: "zzz", cada: 2300 },
      { pose: "cabeceo", ms: 1600, fase: "pregunta", animo: "dormido" },
      { pose: "susto", ms: 2600, fase: "pregunta", animo: "grito", decir: unaF(FRASES_GUION.juntaDespierta) },
      { pose: "sentado", ms: 2600, fase: "junta", animo: "serio", decir: unaF(FRASES_GUION.juntaFin), tipo: "habla" },
    ], "junta");

    const escenaStack = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "teclear", ms: 3600, fase: "lee", animo: "serio", decir: unaF(FRASES_GUION.stackLee), tipo: "habla" },
      { pose: "susto", ms: 1900, fase: "caido", animo: "grito", decir: unaF(FRASES_GUION.stackCae) },
      { pose: "jalarpelo", ms: 4400, fase: "caido", animo: "grito", frases: unaF(FRASES_GUION.stackCrisis), tipoFrases: "grito", cada: 1900 },
      { pose: "teclear", ms: 3600, fase: "caido", animo: "serio", frases: unaF(FRASES_GUION.stackSolo), cada: 1700 },
      { pose: "pregunta", ms: 3200, fase: "caido", animo: "serio", decir: unaF(FRASES_GUION.stackFin), tipo: "habla" },
    ], "stack");

    const escenaWifi = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "cafe", ms: 4200, fase: "lag", animo: "aburrido", al: () => setLag(true), decir: unaF(FRASES_GUION.wifiLag), tipo: "habla" },
      { pose: "senal", ms: 4800, fase: "senal", animo: "grito", al: () => setLag(false), frases: unaF(FRASES_GUION.wifiSenal), tipoFrases: "grito", cada: 1700 },
      { pose: "brinco", ms: 1900, fase: "conecta", animo: "feliz", decir: unaF(FRASES_GUION.wifiOk) },
    ], "wifi", { fin: () => setLag(false) });

    const escenaCampamento = (ahora: number): boolean => {
      const ANCHO_OSO = 76;
      const altoOso = piso() + 74 - 50;
      let avisado = false;
      const pasos: PasoGuion[] = [
        { pose: "sentado", ms: 4200, fase: "fogata", animo: "relajado", decir: unaF(FRASES_GUION.fogata), tipo: "habla" },
        { pose: "cabeceo", ms: 3600, fase: "dormir", animo: "dormido", frases: () => "Z z z", tipoFrases: "zzz", cada: 2000 },
        {
          pose: "cabeceo", fase: "llega-oso", animo: "dormido",
          al: () => {
            // Sale de más allá de la tienda y camina hacia él.
            const W = window.innerWidth;
            actor = s.dir === 1
              ? { x: Math.min(W + 10, s.x + 330), y: altoOso, dir: -1 }
              : { x: Math.max(-ANCHO_OSO - 10, s.x + TAM - 330 - ANCHO_OSO), y: altoOso, dir: 1 };
            setUtileria((u) => (u ? { ...u, actor: { ...actor! } } : u));
          },
          mover: (dt) => {
            if (!actor) return true;
            actor.x += 70 * dt * actor.dir;
            const meta = s.dir === 1 ? s.x + 46 : s.x + TAM - 46 - ANCHO_OSO;
            const falta = Math.abs(actor.x - meta);
            if (!avisado && falta < 160) {
              avisado = true;
              finDialogo = 0;
              ponerAnimo("serio");
              decir(una(FRASES_GUION.oso), "habla", 2200);
            }
            return s.dir === 1 ? actor.x <= meta : actor.x >= meta;
          },
        },
        {
          pose: "susto", ms: 1400, fase: "huye", animo: "grito", decir: unaF(FRASES_GUION.osoRoba),
          al: () => {
            setCalzones(true);
            if (actor) actor.dir = s.dir;
          },
        },
        {
          pose: "perseguir", fase: "huye", animo: "grito", frases: unaF(FRASES_GUION.osoPersigue), tipoFrases: "grito", cada: 1600,
          mover: (dt) => {
            if (!actor) return true;
            actor.x += 205 * dt * actor.dir;
            s.x = Math.max(MARGEN, Math.min(derecha(), s.x + VEL_PERSEGUIR * dt * s.dir));
            return actor.x < -ANCHO_OSO - 20 || actor.x > window.innerWidth + 20;
          },
        },
        { pose: "cubrirse", ms: 4000, fase: "cubrirse", animo: "llorando", frases: unaF(FRASES_GUION.osoCubre), tipoFrases: "grito", cada: 1900 },
      ];
      return empezarGuion(ahora, pasos, "campamento", {
        // Se va volando en calzones un rato, y luego aparece vestido otra vez.
        fin: () => { clearTimeout(quitarCalzones); quitarCalzones = setTimeout(() => setCalzones(false), 5000); },
      });
    };
    const limpiar = () => { setEnMano(null); setExtra(null); };

    const escenaPato = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "explicar", ms: 6000, fase: "escucha", animo: "serio", decir: unaF(FRASES_GUION.patoExplica), tipo: "habla", frases: unaF(FRASES_GUION.patoExplica), cada: 2100 },
      { pose: "brinco", ms: 2300, fase: "escucha", animo: "grito", al: () => setExtra("foco"), decir: unaF(FRASES_GUION.patoFoco) },
      { pose: "cafe", ms: 2800, fase: "nada", animo: "feliz", al: () => setExtra(null), decir: unaF(FRASES_GUION.patoGracias), tipo: "habla" },
    ], "pato", { fin: limpiar });

    const escenaReview = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "encoger", ms: 7000, fase: "review", animo: "serio", decir: () => FRASES_GUION.review[0], tipo: "habla", frases: unaF(FRASES_GUION.review.slice(1)), cada: 1900 },
      { pose: "encoger", ms: 2600, fase: "rechazado", animo: "llorando", decir: unaF(FRASES_GUION.reviewFin), tipo: "habla" },
    ], "review");

    const escenaTanda = (ahora: number): boolean => {
      const socios = usuariosRef.current.filter((a) => a.skin !== skinRef.current).slice(0, 4);
      if (!socios.length) return false;
      const cobrador = socios[socios.length - 1].nombre;
      return empezarGuion(ahora, [
        { pose: "cafe", ms: 3200, fase: "junta", animo: "feliz", decir: unaF(FRASES_GUION.tanda), tipo: "habla" },
        { pose: "comer", ms: 4200, fase: "cuenta", animo: "feliz", frases: unaF(FRASES_GUION.tandaCuenta), cada: 1600 },
        { pose: "susto", ms: 2000, fase: "huye", animo: "grito", decir: () => `¡${cobrador}, regresa con la tanda!` },
        { pose: "jalarpelo", ms: 3600, fase: "huye", animo: "grito", frases: unaF(FRASES_GUION.tandaHuye), tipoFrases: "grito", cada: 1700 },
      ], "tanda", { datos: { avatares: socios } });
    };

    const escenaMerge = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "forcejeo", ms: 5200, fase: "pelea", animo: "grito", decir: () => FRASES_GUION.merge[0], frases: unaF(FRASES_GUION.merge), tipoFrases: "grito", cada: 1700 },
      { pose: "susto", ms: 2800, fase: "separa", animo: "serio", decir: unaF(FRASES_GUION.mergeSepara), tipo: "habla" },
      { pose: "brinco", ms: 2000, fase: "merged", animo: "feliz", decir: unaF(FRASES_GUION.mergeOk) },
    ], "merge");

    const escenaDerrame = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "cafe", ms: 2600, fase: "listo", animo: "feliz", al: () => setEnMano("cafe"), decir: unaF(FRASES_GUION.derrame), tipo: "habla" },
      { pose: "tropiezo", ms: 1200, fase: "tropieza", animo: "grito", al: () => setEnMano(null), decir: unaF(FRASES_GUION.derrameCae) },
      { pose: "susto", ms: 1700, fase: "chispas", animo: "grito", decir: unaF(FRASES_GUION.derrameChispa) },
      { pose: "abanicar", ms: 4400, fase: "abanica", animo: "grito", frases: unaF(FRASES_GUION.derrameAbanica), tipoFrases: "grito", cada: 1700 },
    ], "derrame", { fin: limpiar });

    const escenaNube = (ahora: number): boolean => {
      const sigue = () => { if (actor) { actor.x = s.x - 15; actor.y = s.y + 60; } };
      return empezarGuion(ahora, [
        {
          pose: "cafe", ms: 2200, fase: "sube", animo: "feliz", decir: () => FRASES_GUION.nube[0], tipo: "grito",
          al: () => {
            actor = { x: s.x - 15, y: s.y + 60, dir: 1 };
            setUtileria((u) => (u ? { ...u, actor: { ...actor! } } : u));
          },
        },
        {
          pose: "porra", fase: "sube", animo: "feliz", aire: true, frases: unaF(FRASES_GUION.nube.slice(1)), cada: 2200,
          mover: (dt) => { s.y = Math.max(piso() - 150, s.y - 45 * dt); sigue(); return s.y <= piso() - 150; },
        },
        { pose: "susto", ms: 2400, fase: "factura", animo: "grito", aire: true, decir: unaF(FRASES_GUION.nubeFactura), mover: () => { sigue(); return false; } },
        {
          pose: "tropiezo", fase: "cae", animo: "grito", aire: true, decir: unaF(FRASES_GUION.nubeCae),
          mover: (dt) => { s.y = Math.min(piso(), s.y + 320 * dt); return s.y >= piso(); },
        },
        { pose: "agachar", ms: 500, fase: "cae", animo: "llorando" },
      ], "nube");
    };

    const escenaBecario = (ahora: number): boolean => {
      const ANCHO_BECARIO = 56;
      let rackX = 0;
      return empezarGuion(ahora, [
        {
          pose: "cafe", ms: 2500, fase: "llega", animo: "serio", decir: () => FRASES_GUION.becario[0], tipo: "habla",
          al: () => {
            // El rack queda adelante (x local 120 de la caja); el becario, detrás de él.
            const caja = ANCHO_UTILERIA.becario;
            const x0 = s.dir === 1 ? s.x : s.x + TAM - caja;
            rackX = s.dir === 1 ? x0 + 120 : x0 + caja - 120 - 34;
            actor = { x: s.dir === 1 ? s.x - ANCHO_BECARIO + 6 : s.x + TAM - 6, y: piso() + 74 - 52, dir: s.dir };
            setUtileria((u) => (u ? { ...u, actor: { ...actor! } } : u));
          },
        },
        { pose: "brinco", ms: 2300, fase: "imita-brinco", animo: "serio", decir: () => FRASES_GUION.becario[1], tipo: "habla" },
        {
          pose: "alerta", fase: "corre", animo: "grito", decir: unaF(FRASES_GUION.becarioCorre),
          mover: (dt) => {
            if (!actor) return true;
            actor.x += 130 * dt * s.dir;
            return s.dir === 1 ? actor.x + ANCHO_BECARIO - 14 >= rackX : actor.x + 14 <= rackX + 34;
          },
        },
        { pose: "susto", ms: 1000, fase: "tropieza", animo: "grito" },
        { pose: "jalarpelo", ms: 4200, fase: "cae", animo: "grito", decir: () => FRASES_GUION.becarioTumba[0], frases: unaF(FRASES_GUION.becarioTumba.slice(1)), tipoFrases: "grito", cada: 1700 },
      ], "becario");
    };

    const escenaLunes = (ahora: number): boolean => empezarGuion(ahora, [
      {
        pose: "arrastrar", ms: 5000, animo: "aburrido", al: () => setEnMano("termo"), decir: () => FRASES_GUION.lunes[0], tipo: "habla",
        frases: unaF(FRASES_GUION.lunes.slice(1)), cada: 2200,
        mover: (dt) => { s.x = Math.max(MARGEN, Math.min(derecha(), s.x + 22 * dt * s.dir)); return false; },
      },
      { pose: "cafe", ms: 5000, animo: "dormido", frases: () => "Z z z", tipoFrases: "zzz", cada: 1800 },
    ], null, { fin: limpiar });

    const escenaFutbol = (ahora: number): boolean => {
      // Forzada sin partido hoy: el próximo (o, sin calendario, uno de muestra).
      const p = partidoEnVivo() ?? partidoDeHoy() ?? partidosSeleccion().find((x) => Date.parse(x.inicio) > Date.now())
        ?? { inicio: new Date().toISOString(), rival: "Jamaica", bandera: "🇯🇲", local: true, torneo: "Amistoso" };
      if (!p) return false;
      const partido = { rival: p.rival, bandera: p.bandera, local: p.local };
      const hora = new Date(p.inicio).toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
      // Antes del silbatazo (el mismo día), avisa; durante el partido (o forzado), lo vive.
      const previa = !!partidoDeHoy() && !partidoEnVivo();
      const pasos: PasoGuion[] = previa
        ? [{
          pose: "porra", ms: 5000, fase: "previa", animo: "feliz", al: () => setEnMano("bandera"),
          decir: () => `¡Hoy juega México contra ${p.rival} a las ${hora}!`, frases: unaF(FRASES_GUION.futbolPrevia), cada: 2400,
        }]
        : [
          { pose: "porra", ms: 3400, fase: "partido", animo: "grito", al: () => setEnMano("bandera"), decir: () => "¡Vamos, México!" },
          { pose: "porra", ms: 4200, fase: "partido", animo: "grito", frases: unaF(FRASES_GUION.futbolVivo), tipoFrases: "grito", cada: 1600 },
          Math.random() < 0.5
            ? { pose: "brinco", ms: 3600, fase: "gol", animo: "grito", decir: () => FRASES_GUION.futbolGol[0], frases: unaF(FRASES_GUION.futbolGol), tipoFrases: "grito", cada: 1500 }
            : { pose: "jalarpelo", ms: 3600, fase: "partido", animo: "grito", decir: () => FRASES_GUION.futbolFalla[0], frases: unaF(FRASES_GUION.futbolFalla.slice(1)), tipoFrases: "grito", cada: 1700 },
        ];
      return empezarGuion(ahora, pasos, "futbol", { fin: limpiar, datos: { partido } });
    };

    const escenaPinata = (ahora: number): boolean => empezarGuion(ahora, [
      { pose: "cafe", ms: 2400, fase: "cuelga", animo: "feliz", al: () => { setEnMano("palo"); setExtra("venda"); }, decir: () => FRASES_GUION.pinata[0], tipo: "habla" },
      { pose: "pegar", ms: 1800, fase: "cuelga", animo: "grito", decir: () => FRASES_GUION.pinataGolpe[0] },
      { pose: "pegar", ms: 1800, fase: "cuelga", animo: "grito", decir: () => `${FRASES_GUION.pinata[1]} ${FRASES_GUION.pinataGolpe[1]}` },
      { pose: "pegar", ms: 1300, fase: "rota", animo: "grito", decir: () => FRASES_GUION.pinataGolpe[2] },
      { pose: "brinco", ms: 3000, fase: "rota", animo: "feliz", al: () => setExtra(null), decir: unaF(FRASES_GUION.pinataRota), frases: unaF(FRASES_GUION.pinataRota), tipoFrases: "grito", cada: 1500 },
    ], "pinata", { fin: limpiar });

    const ESCENA_EXTRA: Record<Extra, (ahora: number) => boolean> = {
      elotero: escenaElotero, junta: escenaJunta, stack: escenaStack, wifi: escenaWifi, campamento: escenaCampamento,
      pato: escenaPato, review: escenaReview, tanda: escenaTanda, merge: escenaMerge, derrame: escenaDerrame, nube: escenaNube,
      becario: escenaBecario, lunes: escenaLunes, futbol: escenaFutbol, pinata: escenaPinata,
    };

    // Café (ver FRASES_CAFE).
    let proximoCafe = performance.now() + azar(120_000, 240_000);
    let enCafe = false;
    /** A dónde camina para quedar junto al kiosco. */
    let metaCafe = 0;
    let rumboDesde = 0;
    let idCafe = 0;
    let quitarCafe: ReturnType<typeof setTimeout> | undefined;
    const faseCafe = (fase: FaseCafe) => setCafe((c) => (c ? { ...c, fase } : c));
    const empezarCafe = (ahora: number): boolean => {
      // El kiosco sale del lado con más pantalla, lejos de él, y él camina hasta allá.
      const W = window.innerWidth;
      const dir = (s.x + TAM / 2 < W / 2 ? 1 : -1) as 1 | -1;
      const kx = dir === 1
        ? Math.min(W - MARGEN - CAFE_ANCHO, s.x + TAM + CAFE_LEJOS - CAFE_ANCHO)
        : Math.max(MARGEN, s.x - CAFE_LEJOS);
      // Queda parado junto al mostrador: el cuerpo del kiosco va de x+8 a x+80.
      const meta = dir === 1 ? kx - 58 : kx + CAFE_ANCHO - 22;
      if (Math.abs(meta - s.x) < 120) return false;
      s.dir = dir;
      s.y = piso();
      enCafe = true;
      metaCafe = meta;
      rumboDesde = ahora;
      clearTimeout(quitarCafe);
      idCafe += 1;
      setCafe({ id: idCafe, x: kx, y: piso() - CAFE_ARRIBA, fase: "rumbo", pj: { x: meta, y: s.y } });
      cambiarPose("rumbo");
      ponerAnimo("feliz");
      decir(una(FRASES_CAFE.rumbo), "grito", 2600);
      proximaFrase = ahora + 3200;
      return true;
    };
    const terminarCafe = () => {
      enCafe = false;
      quitarCafe = setTimeout(() => {
        setCafe((c) => (c ? { ...c, saliendo: true } : c));
        quitarCafe = setTimeout(() => setCafe(null), 400);
      }, 300);
      ponerAnimo("serio");
      cambiarPose("agachar", 200);
      s.siguiente = "despegar";
    };

    const terminarPesca = () => {
      pescaJs = null;
      quitarPesca = setTimeout(() => {
        setPesca((p) => (p ? { ...p, saliendo: true } : p));
        quitarPesca = setTimeout(() => setPesca(null), 400);
      }, 200);
      ponerAnimo("serio");
      cambiarPose("agachar", 200);
      s.siguiente = "despegar";
    };

    const terminarArcade = () => {
      const rota = !!arcade && !arcade.gana;
      arcade = null;
      // Rota se queda humeando un rato después de que él se va.
      quitarMaquina = setTimeout(() => {
        setMaquina((m) => (m ? { ...m, saliendo: true } : m));
        quitarMaquina = setTimeout(() => setMaquina(null), 400);
      }, rota ? 3500 : 300);
      ponerAnimo(rota ? "serio" : "feliz");
      cambiarPose("agachar", 200);
      s.siguiente = "despegar";
    };

    let poseActual: Pose = "volar";
    const cambiarPose = (p: Pose, durMs = 0) => {
      s.pose = p;
      s.hasta = durMs ? performance.now() + durMs : 0;
      if (p !== poseActual) {
        poseActual = p;
        setPose(p);
        if (p !== "volar") ponerEstilo("superman");
        if (p === "volar" || p === "despegar") ponerAnimo("feliz");
        else if (p === "caminar") ponerAnimo("serio");
        else if (p === "quieto") ponerAnimo("aburrido");
        if (p === "quieto") proximaFrase = performance.now() + azar(1200, 2500);
        // Descansando, a veces en vez de aburrirse saca la pizza o el refresco.
        if (p === "quieto" && Math.random() < 0.45) {
          const x: Snack = Math.random() < 0.55 ? "pizza" : "refresco";
          ponerSnack(x);
          ponerAnimo(ANIMO_SNACK[x]);
          lanzarMangaPendiente = x;
        } else if (p !== "volar" || snackActual !== "helado") {
          if (snackActual !== null && !(p === "despegar" && snackActual === "helado")) ponerSnack(null);
        }
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

      // Festejo pendiente: interrumpe lo que esté haciendo.
      if (s.festejos.length && !enEscena()) {
        const d = s.festejos.shift()!;
        escenaStore = d.store ?? null;
        escenaClaude = d.claude ?? null;
        if (d.claude) {
          // Claude Code terminó una corrida: cada resultado con su escena.
          const c = d.claude;
          idLetrero += 1;
          finDialogo = 0;
          setDialogo(null);
          if (c.resultado === "ok") {
            cambiarPose("victoria", CLAUDE_OK_MS);
            ponerAnimo("grito");
            lanzarConfeti();
            setLetrero({ tipo: "claude", id: idLetrero, titulo: `🤖 Claude terminó ${c.folio}`, linea: una(FRASES_CLAUDE_OK)(c.nombre) });
          } else if (c.resultado === "pregunta") {
            cambiarPose("pregunta", CLAUDE_PREGUNTA_MS);
            ponerAnimo("serio");
            setLetrero({ tipo: "claude-pregunta", id: idLetrero, titulo: `❓ Claude te pregunta algo · ${c.folio}`, linea: una(FRASES_CLAUDE_PREGUNTA)(c.nombre) });
          } else {
            cambiarPose("chispazo", CLAUDE_FALLO_MS);
            ponerAnimo("llorando");
            setLetrero({ tipo: "claude-fallo", id: idLetrero, titulo: `💥 Claude falló en ${c.folio}`, linea: una(FRASES_CLAUDE_FALLO)(c.nombre) });
          }
          proximaFrase = ahora + 3200;
        } else if ((d.tipo === "store-ok" || d.tipo === "store-fallo") && d.store) {
          // Tienda: huracán con logos de Android/Apple, viñeta y letrero; o llanto si falló.
          const st = d.store;
          const icono = st.plataforma === "ios" ? "" : "🤖";
          s.festejoRepo = st.destino;
          if (st.ok) {
            s.festejoTheta = Math.atan2(s.y - window.innerHeight / 2, s.x - window.innerWidth / 2);
            cambiarPose("festejo", FESTEJO_MS);
            ponerAnimo("grito");
            lanzarConfeti(st.plataforma);
            setLetrero({ tipo: "store", id: idLetrero, titulo: `${icono} Ya se mandó a ${st.destino} · ${st.app}`, linea: una(FRASES_STORE_OK)(st.destino) });
            if (!finManga) lanzarManga(una(VIÑETAS_STORE));
          } else {
            cambiarPose("llorar", LLANTO_MS);
            ponerAnimo("llorando");
            setLetrero({ tipo: "fallo", id: idLetrero, titulo: `❌ Falló el envío a ${st.destino} · ${st.app}`, linea: una(FRASES_STORE_FALLO)(st.destino) });
          }
          proximaFrase = ahora + 2200;
        } else if (d.tipo === "viernes") {
          finDialogo = 0;
          setDialogo(null);
          escenaViernes(ahora, d.repo);
        } else if (d.tipo === "dev-ok" || d.tipo === "dev-fallo") {
          // Dev: brinco en el lugar (o puchero), con su globo; sin letrero ni confeti.
          // Letrero fijo (como PRD, pero azul y más corto): el globo se movía con él y no se leía.
          s.festejoRepo = d.repo;
          idLetrero += 1;
          finDialogo = 0;
          setDialogo(null);
          const ok = d.tipo === "dev-ok";
          cambiarPose("brinco", BRINCO_MS);
          ponerAnimo(ok ? "feliz" : "llorando");
          setLetrero({
            tipo: ok ? "dev" : "dev-fallo",
            id: idLetrero,
            titulo: `${ok ? "🚀 Deploy exitoso a dev" : "⚠️ Falló el deploy a dev"} · ${dondeFue(d)}`,
            linea: una(ok ? FRASES_DEV_OK : FRASES_DEV_FALLO)(d.repo),
          });
          proximaFrase = ahora + BRINCO_MS + 1500;
        } else {
        s.festejoRepo = d.repo;
        s.festejoInicio = ahora;
        idLetrero += 1;
        finDialogo = 0;
        setDialogo(null);
        if (d.tipo === "exito") {
          s.festejoTheta = Math.atan2(s.y - window.innerHeight / 2, s.x - window.innerWidth / 2);
          cambiarPose("festejo", FESTEJO_MS);
          ponerAnimo("grito");
          lanzarConfeti();
          setLetrero({ tipo: "exito", id: idLetrero, titulo: `✅ Deploy exitoso a PRD · ${dondeFue(d)}`, linea: fraseDeploy(d.repo) });
        } else {
          cambiarPose("llorar", LLANTO_MS);
          ponerAnimo("llorando");
          setLetrero({ tipo: "fallo", id: idLetrero, titulo: `❌ Falló el deploy a PRD · ${dondeFue(d)}`, linea: fraseFallo(d.repo) });
        }
        proximaFrase = ahora + 2200;
        }
      }

      tomarAviso();
      // El aviso no espera a que acabe la escena (arcade, pesca…): la acelera.
      if (s.megafono && s.alertaGritos.length && s.pose !== "alerta" && enEscena() && !guion && s.hasta) {
        s.hasta = Math.min(s.hasta, ahora + 300);
      }

      // Alerta de tickets: baja al piso y se queda gritando (el festejo manda más).
      if (s.alertaGritos.length && s.pose !== "alerta" && !enEscena()) {
        cambiarPose("alerta");
        ponerAnimo("grito");
        s.alertaHasta = ahora + (s.alertaDur || ALERTA_MS);
        s.alertaDur = 0;
        s.alertaIdx = 0;
        proximaFrase = ahora;
        if (s.megafono && avisoActual) {
          // Se sorprende («!») mientras el avatar de quien manda entra desde la
          // orilla con más espacio; luego ése lo grita.
          finDialogo = 0;
          setDialogo(null);
          setLlamando(true);
          proximaFrase = Infinity;
          // El mensajero sale en cuanto el propio toca el piso (ver case "alerta").
          faseMensajero = null;
        }
      }

      // Helado en pleno vuelo, de vez en cuando (y se lo termina en unos segundos).
      if (s.pose === "volar") {
        if (!snackActual && ahora >= proximoHelado) {
          proximoHelado = ahora + azar(25_000, 45_000);
          if (Math.random() < 0.5) {
            ponerSnack("helado");
            ponerAnimo("lamiendo");
            heladoHasta = ahora + azar(7000, 10_000);
            if (!finManga) lanzarManga(una(VIÑETAS_SNACK.helado));
            else if (!finDialogo) decir(una(FRASES.helado), "habla", 2600);
          }
        } else if (snackActual === "helado" && ahora >= heladoHasta) {
          ponerSnack(null);
          ponerAnimo("feliz");
        }
      } else if (snackActual === "helado") ponerSnack(null);

      const fin = s.hasta && ahora >= s.hasta;

      if (guion) correrGuion(ahora, dt);
      else switch (s.pose) {
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
          s.vel += (crucero() - s.vel) * Math.min(1, dt * 0.6);
          // Cambia de estilo cada tanto: puño al frente, nadando o boca arriba.
          if (s.pose === "volar" && ahora >= proximoEstilo) {
            proximoEstilo = ahora + azar(9000, 16_000);
            const r = Math.random();
            const nuevo: EstiloVuelo = snackActual === "helado" ? "superman" : r < 0.5 ? "superman" : r < 0.75 ? "nado" : "relax";
            if (nuevo !== estiloActual) {
              ponerEstilo(nuevo);
              ponerAnimo(nuevo === "relax" ? "relajado" : "feliz");
              if (nuevo !== "superman" && !finDialogo) decir(una(FRASES[nuevo]), "habla", 2600);
            }
          }

          s.tiempoBob += dt;
          s.x += Math.cos(s.angulo) * s.vel * dt * s.dir;
          s.y += Math.sin(s.angulo) * s.vel * dt + Math.sin(s.tiempoBob * 3) * 0.25;

          // Paredes: se voltea y sale con otro ángulo.
          if (s.x <= MARGEN || s.x >= derecha()) {
            s.x = Math.max(MARGEN, Math.min(derecha(), s.x));
            s.dir = (s.x <= MARGEN ? 1 : -1) as 1 | -1;
            s.angulo = Math.max(-1, Math.min(1, -s.angulo * 0.5 + azar(-0.45, 0.45)));
            s.vel = azar(...VEL_VUELO);
            // A veces se queja del golpe (y ese globo dura lo suficiente para leerse).
            if (!finDialogo && Math.random() < 0.45) {
              const golpe = Math.random() < 0.65;
              decir(una(golpe ? FRASES.golpe : FRASES.pared), golpe ? "grito" : "habla", golpe ? 2400 : 1600);
              if (golpe) {
                ponerAnimo("grito");
                proximaFrase = ahora + 3500;
                if (!finManga && Math.random() < 0.6) lanzarManga(una(VIÑETAS_GOLPE));
              }
            }
          }
          // Techo: voltereta.
          if (s.y <= TECHO && s.pose === "volar") {
            s.y = TECHO;
            cambiarPose("girar", 520);
            if (Math.random() < 0.65) decir(una(Math.random() < 0.6 ? FRASES.golpe : FRASES.techo), "grito", 2400);
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
        case "festejo": {
          // Huracán: espiral alrededor del centro, el radio crece y se cierra.
          const t = Math.min(1, (ahora - s.festejoInicio) / FESTEJO_MS);
          const cx = window.innerWidth / 2 - TAM / 2;
          const cy = Math.max(TECHO + 120, window.innerHeight / 2 - TAM / 2);
          const radio = 40 + Math.sin(t * Math.PI) * Math.min(260, window.innerWidth / 4);
          s.festejoTheta += dt * 7.5;
          const tx = cx + Math.cos(s.festejoTheta) * radio;
          const ty = cy + Math.sin(s.festejoTheta) * radio * 0.55;
          s.x += (tx - s.x) * Math.min(1, dt * 6);
          s.y += (ty - s.y) * Math.min(1, dt * 6);
          s.dir = (Math.sin(s.festejoTheta) > 0 ? -1 : 1) as 1 | -1;
          if (ahora >= proximaFrase) {
            const linea = escenaStore ? una(FRASES_STORE_OK)(escenaStore.destino) : fraseDeploy(s.festejoRepo);
            setLetrero((l) => (l ? { ...l, linea } : l));
            proximaFrase = ahora + 3200;
          }
          if (fin) {
            soltarLetrero();
            cambiarPose("volar");
            s.angulo = azar(-0.9, 0.3);
            s.vel = 260;
            s.dir = signoAzar();
          }
          break;
        }
        case "llorar": {
          // Cae al piso donde esté, se arrodilla y llora.
          if (s.y < piso()) s.y = Math.min(piso(), s.y + 480 * dt);
          if (ahora >= proximaFrase) {
            const linea = escenaStore ? una(FRASES_STORE_FALLO)(escenaStore.destino) : fraseFallo(s.festejoRepo);
            setLetrero((l) => (l ? { ...l, linea } : l));
            proximaFrase = ahora + 3200;
          }
          if (fin) {
            soltarLetrero();
            ponerAnimo("serio");
            cambiarPose("agachar", 260);
            s.siguiente = "despegar";
          }
          break;
        }
        case "brinco": {
          // Se queda donde está (en el aire o en el piso) brincando; al terminar sigue su vuelo.
          if (fin) {
            soltarLetrero();
            ponerAnimo("feliz");
            if (s.y >= piso() - 1) {
              cambiarPose("agachar", 160);
              s.siguiente = "despegar";
            } else cambiarPose("volar");
          }
          break;
        }
        case "alerta": {
          // Cae rápido al piso donde esté y ahí se para a gritar.
          if (s.y < piso()) s.y = Math.min(piso(), s.y + 520 * dt);
          if (llamadaHasta && ahora >= llamadaHasta) {
            llamadaHasta = 0;
            setLlamando(false);
          }
          if (s.megafono && avisoActual && !faseMensajero && s.y >= piso() - 1) {
            // Ya en el piso: entra el de quien manda, por la orilla con más espacio.
            const lado = s.x > TAM + 60 ? "izq" : "der";
            const x = lado === "izq" ? s.x - TAM - 20 : Math.min(window.innerWidth - TAM - MARGEN, s.x + TAM + 20);
            s.dir = (lado === "izq" ? -1 : 1) as 1 | -1;
            faseMensajero = "entra";
            faseHasta = ahora + MENSAJERO_ENTRA_MS;
            llamadaHasta = faseHasta;
            setMensajero({ ...avisoActual, x, y: piso(), lado, fase: "entra" });
          }
          if (s.megafono && avisoActual && faseMensajero && ahora >= faseHasta) {
            const a = avisoActual;
            if (faseMensajero === "entra") {
              // Llegó: lo grita (con su audio o con la voz de su personaje).
              faseMensajero = "grita";
              faseHasta = ahora + Math.max(MENSAJERO_GRITA_MS, a.texto.length * 70);
              setMensajero((m) => (m ? { ...m, fase: "grita" } : m));
              ponerAnimo("grito");
              if (audioAviso) {
                const audio = audioAviso;
                const alargar = () => {
                  if (Number.isFinite(audio.duration)) faseHasta = Math.max(faseHasta, performance.now() + audio.duration * 1000 + 1500);
                };
                if (audio.readyState >= 1) alargar();
                else audio.onloadedmetadata = alargar;
                // Mientras suena su audio, la voz del avatar propio no lo tapa.
                callarVoz(MENSAJERO_GRITA_MS);
                audio.onended = () => callarVoz(0);
                // Sin interacción previa el navegador puede bloquearlo: queda el globo.
                void audio.play().catch(() => callarVoz(0));
              } else if (a.voz && !a.recordatorio && a.texto) hablar(a.texto, (a.deSkin ?? skinRef.current) as Skin);
              if (!a.recordatorio) {
                window.dispatchEvent(new CustomEvent(EVENTO_AVISO_ENTREGADO, { detail: { convId: a.convId, msgId: a.msgId } }));
              }
            } else if (faseMensajero === "grita") {
              faseMensajero = "sale";
              faseHasta = ahora + MENSAJERO_SALE_MS;
              setMensajero((m) => (m ? { ...m, fase: "sale" } : m));
            } else {
              terminarAviso();
            }
          }
          if (!s.megafono && !finDialogo && ahora >= proximaFrase) {
            decir(s.alertaGritos[s.alertaIdx % s.alertaGritos.length], "grito", 2600);
            s.alertaIdx += 1;
            proximaFrase = ahora + 3000;
          }
          if (ahora >= s.alertaHasta || !s.alertaGritos.length) {
            if (s.megafono) terminarAviso();
            s.alertaGritos = [];
            alertaRef.current = null;
            cambiarPose("agachar", 180);
            s.siguiente = "despegar";
          }
          break;
        }
        case "victoria":
        case "pregunta":
        case "chispazo": {
          // Baja al piso donde esté y ahí actúa (la pose la anima personaje.css).
          if (s.y < piso()) s.y = Math.min(piso(), s.y + 520 * dt);
          if (escenaClaude && ahora >= proximaFrase) {
            const frases = s.pose === "victoria" ? FRASES_CLAUDE_OK : s.pose === "pregunta" ? FRASES_CLAUDE_PREGUNTA : FRASES_CLAUDE_FALLO;
            const nombre = escenaClaude.nombre;
            setLetrero((l) => (l ? { ...l, linea: una(frases)(nombre) } : l));
            proximaFrase = ahora + 3200;
          }
          if (fin || s.cortarEscena) {
            s.cortarEscena = false;
            soltarLetrero();
            escenaClaude = null;
            ponerAnimo("feliz");
            cambiarPose("agachar", 200);
            s.siguiente = "despegar";
          }
          break;
        }
        case "arcade": {
          // Machacando botones; al final, gana o pierde.
          if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_ARCADE.jugando), Math.random() < 0.4 ? "grito" : "habla", 1900);
            proximaFrase = ahora + azar(2600, 3800);
          }
          if (fin) {
            if (arcade?.gana) {
              cambiarPose("marometa", ARCADE_GANA_MS);
              faseMaquina("gana");
              decir(una(FRASES_ARCADE.gana), "grito", 2200);
            } else {
              cambiarPose("berrinche", ARCADE_BERRINCHE_MS);
              faseMaquina("pierde");
              decir(una(FRASES_ARCADE.madre), "grito", 2200);
            }
            ponerAnimo("grito");
            proximaFrase = ahora + 2400;
          }
          break;
        }
        case "marometa": {
          if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_ARCADE.gana), "grito", 2000);
            proximaFrase = ahora + 2300;
          }
          if (fin) terminarArcade();
          break;
        }
        case "berrinche": {
          // Primero contra la máquina; ya rota, contra quien está logueado.
          if (!finDialogo && ahora >= proximaFrase) {
            const n = nombreRef.current || "tú";
            const texto = !arcade?.encabronado
              ? una(FRASES_ARCADE.madre)
              : Math.random() < 0.25 ? una(FRASES_ARCADE.rota) : una(FRASES_ARCADE.usuario)(n);
            decir(texto, "grito", 2300);
            proximaFrase = ahora + 2500;
          }
          if (fin) {
            if (arcade && !arcade.encabronado) {
              cambiarPose("patada", ARCADE_PATADA_MS);
              faseMaquina("patada");
              decir(una(FRASES_ARCADE.patada), "grito", 1400);
              proximaFrase = ahora + ARCADE_PATADA_MS + 200;
            } else terminarArcade();
          }
          break;
        }
        case "patada": {
          if (fin) {
            if (arcade) arcade.encabronado = true;
            faseMaquina("rota");
            cambiarPose("berrinche", ARCADE_ENCABRONADO_MS);
            ponerAnimo("grito");
            finDialogo = 0;
            proximaFrase = ahora + 300;
          }
          break;
        }
        case "pescar": {
          // Esperando a que pique; al final, jala.
          if (!finDialogo && ahora >= proximaFrase) {
            if (Math.random() < 0.6) decir(una(FRASES_PESCA.esperando), "habla", 2200);
            proximaFrase = ahora + azar(3000, 4500);
          }
          if (fin && pescaJs) {
            const ultimo = pescaJs.n + 1 >= pescaJs.lances;
            const esPez = (pescaJs.forzarPez && pescaJs.n === 0) || (Math.random() < (ultimo ? 0.35 : 0.2));
            // El pez sale hacia donde haya más pantalla, para que la persecución luzca.
            const caja = pescaRef.current;
            const izq = caja ? caja.x : 0;
            const der = caja ? window.innerWidth - (caja.x + PESCA_ANCHO) : 0;
            const presa: Presa = esPez
              ? { tipo: "pez", num: 0, adelante: s.dir === 1 ? der > izq : izq > der }
              : Math.random() < 0.5
                ? { tipo: "ticket", num: 1200 + Math.floor(Math.random() * 250) }
                : { tipo: "pr", num: 100 + Math.floor(Math.random() * 450) };
            if (esPez) pescaJs.lances = pescaJs.n + 1; // tras el pez ya no hay más lances
            cambiarPesca({ fase: "jalando", presa, lance: pescaJs.n });
            cambiarPose("jalar", PESCA_JALAR_MS);
            ponerAnimo("grito");
            decir(una(FRASES_PESCA.pica), "grito", 1400);
            proximaFrase = ahora + PESCA_JALAR_MS + 300;
          }
          break;
        }
        case "jalar": {
          if (fin && pescaJs) {
            const presa = pescaRef.current?.presa;
            if (presa?.tipo === "pez") {
              // Cae al suelo (detrás de él o pasando el charco) y sale brincando.
              const caja = pescaRef.current!;
              const atras = !presa.adelante;
              const dirPez = (atras ? -caja.dir : caja.dir) as 1 | -1;
              // Detrás: x local -14..14 de la caja (espejo si mira a la izquierda); adelante: pasando el charco.
              const local = atras ? -14 : PESCA_ANCHO - 14;
              pescaJs.pez = {
                x: caja.dir === 1 ? caja.x + local : caja.x + PESCA_ANCHO - local - 28,
                y: piso() + PIES - 14,
                dir: dirPez,
              };
              cambiarPesca({ fase: "persecucion", presa: null, pez: { ...pescaJs.pez } });
              s.dir = dirPez;
              cambiarPose("perseguir");
              decir(una(FRASES_PESCA.escapa), "grito", 1800);
              proximaFrase = ahora + 2000;
            } else if (presa) {
              cambiarPesca({ fase: "presume" });
              cambiarPose("presume", PESCA_PRESUME_MS);
              ponerAnimo("feliz");
              decir(una(presa.tipo === "ticket" ? FRASES_PESCA.ticket : FRASES_PESCA.pr)(presa.num), "grito", 2600);
              proximaFrase = ahora + PESCA_PRESUME_MS;
            } else terminarPesca();
          }
          break;
        }
        case "presume": {
          if (fin && pescaJs) {
            pescaJs.n += 1;
            if (pescaJs.n < pescaJs.lances) {
              cambiarPesca({ fase: "esperando", presa: null });
              cambiarPose("pescar", azar(...PESCA_ESPERA_MS));
              ponerAnimo("relajado");
            } else terminarPesca();
          }
          break;
        }
        case "perseguir": {
          // El pez siempre va más rápido: se sale de la pantalla y él se queda con el coraje.
          const pez = pescaJs?.pez;
          if (!pez) { terminarPesca(); break; }
          pez.x += VEL_PEZ * dt * pez.dir;
          s.x = Math.max(MARGEN, Math.min(derecha(), s.x + VEL_PERSEGUIR * dt * s.dir));
          if (pezRef.current) pezRef.current.style.transform = `translate3d(${pez.x.toFixed(1)}px, ${pez.y}px, 0) scaleX(${pez.dir})`;
          if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_PESCA.persigue), "grito", 1500);
            proximaFrase = ahora + 1800;
          }
          if (pez.x < -60 || pez.x > window.innerWidth + 20) {
            pescaJs!.pez = null;
            setPesca(null);
            cambiarPose("coraje", PESCA_CORAJE_MS);
            ponerAnimo("grito");
            finDialogo = 0;
            proximaFrase = ahora;
          }
          break;
        }
        case "coraje": {
          if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_PESCA.seFue), "grito", 2200);
            proximaFrase = ahora + 2400;
          }
          if (fin) terminarPesca();
          break;
        }
        case "rumbo": {
          // Camina (con ganas) hasta el kiosco.
          s.x += VEL_CAMINAR * 1.8 * dt * s.dir;
          const llego = s.dir === 1 ? s.x >= metaCafe : s.x <= metaCafe;
          if (llego || ahora - rumboDesde > 14_000) {
            s.x = metaCafe;
            setCafe((c) => (c ? { ...c, fase: "llega", pj: { x: s.x, y: s.y } } : c));
            cambiarPose("cafe", CAFE_MS.llega);
            finDialogo = 0;
            decir(una(FRASES_CAFE.llega), "habla", 1800);
            proximaFrase = ahora + CAFE_MS.llega;
          } else if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_CAFE.rumbo), "habla", 2000);
            proximaFrase = ahora + 3500;
          }
          break;
        }
        case "cafe": {
          // Llegó al kiosco; saca el celular y pide por la app.
          if (fin) {
            faseCafe("app");
            cambiarPose("celular", CAFE_MS.app);
            ponerAnimo("serio");
            decir(una(FRASES_CAFE.app), "habla", 2600);
            proximaFrase = ahora + 2800;
          }
          break;
        }
        case "celular": {
          if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_CAFE.app), "habla", 2000);
            proximaFrase = ahora + 3000;
          }
          if (fin) {
            faseCafe("bug");
            cambiarPose("susto", CAFE_MS.bug);
            ponerAnimo("grito");
            finDialogo = 0;
            decir(una(FRASES_CAFE.bug), "grito", 2400);
            proximaFrase = ahora + CAFE_MS.bug;
          }
          break;
        }
        case "susto": {
          if (fin) {
            faseCafe("tonito");
            cambiarPose("pensar", CAFE_MS.tonito);
            ponerAnimo("serio");
            finDialogo = 0;
            decir(una(FRASES_CAFE.tonito), "grito", 3000);
            proximaFrase = ahora + 3300;
          }
          break;
        }
        case "pensar": {
          if (!finDialogo && ahora >= proximaFrase) {
            decir(una(FRASES_CAFE.tonito), "habla", 2600);
            proximaFrase = ahora + 4000;
          }
          if (fin) terminarCafe();
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
            // Lo forzado (eventos de prueba) primero; luego arcade o pesca, si ya toca.
            if (extraForzada && ESCENA_EXTRA[extraForzada](ahora)) {
              proxExtra[extraForzada] = ahora + azar(...(CADA_EXTRA[extraForzada]?.() ?? EXTRA_CADA_MS));
              extraForzada = null;
              break;
            }
            if (proximoCafe === 0 && empezarCafe(ahora)) {
              proximoCafe = ahora + azar(...CAFE_CADA_MS);
              break;
            }
            if (proximaPesca === 0 && empezarPesca(ahora, pezForzado)) {
              proximaPesca = ahora + azar(...PESCA_CADA_MS);
              break;
            }
            if (ahora >= proximoArcade && (proximoArcade === 0 || Math.random() < 0.6) && empezarArcade(ahora)) {
              proximoArcade = ahora + azar(...ARCADE_CADA_MS);
              break;
            }
            if (ahora >= proximaPesca && Math.random() < 0.6 && empezarPesca(ahora, false)) {
              proximaPesca = ahora + azar(...PESCA_CADA_MS);
              break;
            }
            if (ahora >= proximoCafe && Math.random() < 0.6 && empezarCafe(ahora)) {
              proximoCafe = ahora + azar(...CAFE_CADA_MS);
              break;
            }
            const tocan = EXTRAS.filter((e) => ahora >= proxExtra[e] && (DISPONIBLE[e]?.() ?? true));
            if (tocan.length && Math.random() < 0.6) {
              const e = una(tocan);
              proxExtra[e] = ahora + azar(...(CADA_EXTRA[e]?.() ?? EXTRA_CADA_MS));
              if (ESCENA_EXTRA[e](ahora)) break;
            }
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

      if (finManga && ahora >= finManga) {
        finManga = 0;
        setManga(null);
      }
      if (lanzarMangaPendiente) {
        const x = lanzarMangaPendiente;
        lanzarMangaPendiente = null;
        lanzarManga(una(VIÑETAS_SNACK[x]));
        proximaFrase = ahora + MANGA_MS + 1200;
      }
      if (s.pose === "volar" && !finManga && !finDialogo && ahora >= proximaMangaVuelo) {
        proximaMangaVuelo = ahora + azar(15_000, 30_000);
        lanzarManga(una(snackActual ? VIÑETAS_SNACK[snackActual] : VIÑETAS));
      }

      // Globos: uno a la vez, cada pocos segundos según lo que esté haciendo.
      if (finDialogo && ahora >= finDialogo) {
        finDialogo = 0;
        setDialogo(null);
        if (animoActual === "grito" && s.pose !== "alerta" && !arcade && !pescaJs && !enCafe && !guion) ponerAnimo("feliz");
      }
      if (!finDialogo && ahora >= proximaFrase && s.pose !== "alerta" && !enEscena()) {
        if (s.pose === "volar" && snackActual === "helado") {
          // Con helado no grita: lo disfruta.
          if (Math.random() < 0.5) decir(una(FRASES.helado), "habla", 2400);
          proximaFrase = ahora + azar(4000, 7000);
        } else if (s.pose === "volar" && estiloActual !== "superman") {
          // Nadando o boca arriba no grita: comenta tranquilo.
          if (Math.random() < 0.55) decir(una(FRASES[estiloActual]), "habla", 2600);
          proximaFrase = ahora + azar(5000, 9000);
        } else if (s.pose === "volar") {
          if (Math.random() < ganasDeQueLoAtrapen()) {
            ponerAnimo("feliz");
            decir(una(FRASES.atrapameVuelo), "grito", 2400);
          } else if (Math.random() < 0.6) {
            ponerAnimo("grito");
            decir(una(FRASES.volar), "grito", 1800);
          }
          proximaFrase = ahora + azar(4000, 9000);
        } else if (s.pose === "caminar") {
          if (Math.random() < ganasDeQueLoAtrapen()) decir(una(FRASES.atrapame), "habla", 2600);
          else if (Math.random() < 0.7) decir(fraseDe("caminar", FRASES.caminar));
          proximaFrase = ahora + azar(3500, 7000);
        } else if (s.pose === "quieto" && (snackActual === "pizza" || snackActual === "refresco")) {
          // Con antojo no se duerme: come y lo comenta (y a veces lo resalta en viñeta).
          if (!finManga && Math.random() < 0.5) lanzarManga(una(VIÑETAS_SNACK[snackActual]));
          else if (Math.random() < 0.7) decir(una(FRASES[snackActual]), "habla", 2600);
          proximaFrase = ahora + azar(3500, 6000);
        } else if (s.pose === "quieto" && !snackActual && ahora >= proximoChiste && contarChiste(ahora)) {
          // Un chiste a su modo (ver personalidades.ts); el siguiente, en un rato.
          proximoChiste = ahora + azar(35_000, 80_000);
        } else if (s.pose === "quieto" && !finManga && Math.random() < 0.55) {
          // Cuadro de manga: resalta su expresión con algo chusco.
          lanzarManga(una(snackActual ? VIÑETAS_SNACK[snackActual] : VIÑETAS));
          proximaFrase = ahora + MANGA_MS + 1500;
        } else if (s.pose === "quieto") {
          // Primero se aburre (y lo dice); después le da sueño.
          if (animoActual === "aburrido" && Math.random() < ganasDeQueLoAtrapen()) {
            decir(una(FRASES.atrapame), "habla", 2600);
          } else if (animoActual === "aburrido" && Math.random() < 0.55) {
            decir(fraseDe("aburrido", FRASES.aburrido), "habla", 2600);
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
          : s.pose === "festejo"
            ? 70
            : 0;
      s.inclinado += (objetivo - s.inclinado) * Math.min(1, dt * 7);

      el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
      // El globo se acomoda para no salirse: hacia adentro en las orillas y
      // debajo del personaje cuando va pegado al techo.
      // Junto a la maquinita, el charco o el kiosco, el globo se abre hacia el otro
      // lado para no taparlos (mira hacia el objeto: "der" lo abre a la izquierda).
      const conObjeto = arcade || pescaJs || (enCafe && s.pose !== "rumbo")
        || (guion && s.pose !== "perseguir" && s.pose !== "brinco");
      const orilla = s.x < 110 ? "izq" : s.x > window.innerWidth - TAM - 110 ? "der" : "";
      // Pegado a la orilla manda la orilla (si no, el globo se sale de la pantalla).
      const borde = conObjeto && !orilla ? (s.dir === 1 ? "der" : "izq") : orilla;
      const arriba = s.y < TECHO + 70 ? "1" : "";
      if (el.dataset.borde !== borde) el.dataset.borde = borde;
      if (el.dataset.arriba !== arriba) el.dataset.arriba = arriba;
      if (inclinacion.current) inclinacion.current.style.transform = `rotate(${s.inclinado.toFixed(1)}deg)`;
      if (orientacion.current) orientacion.current.style.transform = `scaleX(${s.dir})`;
    };

    const encolar = (tipo: Letrero["tipo"] | "dev-ok" | "dev-fallo") => (e: Event) => {
      const d = (e as CustomEvent<DetalleFestejo>).detail ?? { repo: "el repo" };
      // Con el chat abierto (pausa) solo cae el confeti; la escena espera.
      if (tipo === "exito" && pausaRef.current) lanzarConfeti();
      s.festejos.push({ ...d, tipo });
    };
    const alFestejo = encolar("exito");
    const alFallo = encolar("fallo");
    const alDevOk = encolar("dev-ok");
    const alDevFallo = encolar("dev-fallo");
    window.addEventListener(EVENTO_FESTEJO, alFestejo);
    window.addEventListener(EVENTO_FALLO, alFallo);
    window.addEventListener(EVENTO_DEV_OK, alDevOk);
    window.addEventListener(EVENTO_DEV_FALLO, alDevFallo);
    const alStore = (e: Event) => {
      const st = (e as CustomEvent<DetalleStore>).detail;
      if (!st) return;
      if (st.ok && pausaRef.current) lanzarConfeti(st.plataforma);
      s.festejos.push({ repo: st.app, tipo: st.ok ? "store-ok" : "store-fallo", store: st });
    };
    window.addEventListener(EVENTO_STORE, alStore);
    const alAlerta = (e: Event) => {
      const gritos = (e as CustomEvent<DetalleAlerta>).detail?.gritos ?? [];
      if (!gritos.length) return;
      s.alertaGritos = gritos;
      alertaRef.current = { apagar: () => { s.alertaGritos = []; } };
    };
    window.addEventListener(EVENTO_ALERTA_TICKETS, alAlerta);
    // Avisos: a la cola (uno por conversación: el nuevo reemplaza al que esperaba).
    const alAviso = (e: Event) => {
      const m = (e as CustomEvent<AvisoParaAvatar>).detail;
      if (!m || (avisoActual?.convId === m.convId && avisoActual.msgId === m.msgId)) return;
      const i = colaAvisos.findIndex((x) => x.convId === m.convId);
      if (i >= 0) colaAvisos.splice(i, 1, m);
      else colaAvisos.push(m);
    };
    window.addEventListener(EVENTO_AVISO, alAviso);
    const alClaude = (e: Event) => {
      const c = (e as CustomEvent<DetalleClaude>).detail;
      if (!c) return;
      if (c.resultado === "ok" && pausaRef.current) lanzarConfeti();
      s.festejos.push({ repo: c.folio, tipo: "claude-ok", claude: c });
      // El clic durante (o después de) la escena lleva a Tickets.
      alertaRef.current = { apagar: () => { s.cortarEscena = true; } };
    };
    window.addEventListener(EVENTO_CLAUDE, alClaude);
    // Juega en cuanto vuelva a pisar el suelo y termine de caminar.
    const alArcade = (e: Event) => {
      const g = (e as CustomEvent<{ gana?: boolean }>).detail?.gana;
      arcadeForzado = typeof g === "boolean" ? g : null;
      proximoArcade = 0;
      s.ganasDeAterrizar = 0;
      if (s.pose === "caminar") s.hasta = performance.now();
    };
    window.addEventListener(EVENTO_ARCADE, alArcade);
    // Pesca en cuanto vuelva a pisar el suelo y termine de caminar.
    const alPesca = (e: Event) => {
      pezForzado = (e as CustomEvent<{ pez?: boolean }>).detail?.pez === true;
      proximaPesca = 0;
      s.ganasDeAterrizar = 0;
      if (s.pose === "caminar") s.hasta = performance.now();
    };
    window.addEventListener(EVENTO_PESCA, alPesca);
    // Café en cuanto vuelva a pisar el suelo y termine de caminar.
    const alCafe = () => {
      proximoCafe = 0;
      s.ganasDeAterrizar = 0;
      if (s.pose === "caminar") s.hasta = performance.now();
    };
    window.addEventListener(EVENTO_CAFE, alCafe);
    // Arrancó un deploy a PRD: en viernes en la tarde, a rezarle a San Rollback.
    const alPrdInicio = (e: Event) => {
      const d = (e as CustomEvent<DetalleFestejo & { forzar?: boolean }>).detail;
      if (!d || (!esViernesTarde() && !d.forzar)) return;
      s.festejos.push({ ...d, tipo: "viernes" });
    };
    window.addEventListener(EVENTO_PRD_INICIO, alPrdInicio);
    const alEscena = (e: Event) => {
      const esc = (e as CustomEvent<{ escena?: string }>).detail?.escena;
      if (esc === "viernes") {
        s.festejos.push({ repo: "sozu-admin", tipo: "viernes" });
        return;
      }
      if (!EXTRAS.includes(esc as Extra)) return;
      extraForzada = esc as Extra;
      s.ganasDeAterrizar = 0;
      if (s.pose === "caminar") s.hasta = performance.now();
    };
    window.addEventListener(EVENTO_ESCENA, alEscena);

    frame = requestAnimationFrame(paso);
    const alRedimensionar = () => {
      s.x = Math.min(s.x, derecha());
      s.y = Math.min(s.y, piso());
    };
    window.addEventListener("resize", alRedimensionar);
    return () => {
      clearTimeout(quitarLetrero);
      clearTimeout(quitarMaquina);
      clearTimeout(quitarPesca);
      clearTimeout(quitarCafe);
      clearTimeout(quitarUtileria);
      clearTimeout(quitarCalzones);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", alRedimensionar);
      window.removeEventListener(EVENTO_FESTEJO, alFestejo);
      window.removeEventListener(EVENTO_FALLO, alFallo);
      window.removeEventListener(EVENTO_DEV_OK, alDevOk);
      window.removeEventListener(EVENTO_DEV_FALLO, alDevFallo);
      window.removeEventListener(EVENTO_STORE, alStore);
      window.removeEventListener(EVENTO_ALERTA_TICKETS, alAlerta);
      window.removeEventListener(EVENTO_AVISO, alAviso);
      audioAviso?.pause();
      window.removeEventListener(EVENTO_CLAUDE, alClaude);
      window.removeEventListener(EVENTO_ARCADE, alArcade);
      window.removeEventListener(EVENTO_PESCA, alPesca);
      window.removeEventListener(EVENTO_CAFE, alCafe);
      window.removeEventListener(EVENTO_PRD_INICIO, alPrdInicio);
      window.removeEventListener(EVENTO_ESCENA, alEscena);
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
      aria-label={`Abrir a GeorgIA, como ${nombre} (Alt+K)`}
      aria-keyshortcuts="Alt+K"
      data-pausa={pausaLocal || undefined}
      data-lag={lag || undefined}
      // Con el panel abierto se esconde (sigue montado: al cerrar reaparece donde iba).
      data-oculto={pausado || undefined}
      aria-hidden={pausado || undefined}
      tabIndex={pausado ? -1 : undefined}
      onClick={(e) => {
        const alerta = alertaRef.current;
        alerta?.apagar();
        alertaRef.current = null;
        marcarAtrapado();
        onClick(
          alerta?.motivo === "avisos" ? "avisos" : alerta && alerta.motivo !== "chat" ? "tickets" : "chat",
          alerta?.convId,
          e.currentTarget.getBoundingClientRect(),
        );
      }}
      onPointerEnter={congelar(true)}
      onPointerLeave={congelar(false)}
      onFocus={congelar(true)}
      onBlur={congelar(false)}
    >
      {/* En el festejo el personaje gira en huracán: el grito va en un letrero
          fijo arriba al centro (portal a body, porque dentro del botón —que
          se mueve con transform— un `fixed` viajaría con él y no se leería). */}
      {letrero &&
        createPortal(
          <div key={letrero.id} className="agente-volador__letrero" data-tipo={letrero.tipo} aria-live="polite">
            <span className="agente-volador__letrero-titulo">{letrero.titulo}</span>
            <span key={letrero.linea} className="agente-volador__letrero-linea">{letrero.linea}</span>
          </div>,
          document.body,
        )}
      {manga && !pausado &&
        createPortal(
          <div
            key={manga.id}
            className="agente-manga"
            data-estilo={manga.estilo}
            data-snack={manga.snack ?? undefined}
            aria-hidden
            style={{
              left: Math.min(Math.max(8, manga.x - 70), window.innerWidth - 248),
              // Arriba del globo de diálogo (no encima de él); pegado al techo, abajo.
              top: manga.y > 290 ? manga.y - 262 : manga.y + 100,
            }}
          >
            {manga.estilo === "zoom" && <div className="agente-manga__lineas" />}
            {manga.estilo === "shock" && <div className="agente-manga__rayo" />}
            {manga.estilo === "shoujo" && (
              <div className="agente-manga__brillos">
                {["✨", "🌸", "✨", "🌸", "✨"].map((b, i) => <span key={i}>{b}</span>)}
              </div>
            )}
            <div className="agente-manga__cara">
              <Personaje pose="quieto" animo={manga.animo} snack={manga.snack ?? null} />
            </div>
            {manga.estilo === "gota" && <span className="agente-manga__gota">💧</span>}
            <span className="agente-manga__nombre">{nombre}</span>
            <span className="agente-manga__texto">{manga.texto}</span>
          </div>,
          document.body,
        )}
      {utileria && createPortal(<UtileriaEscena u={utileria} pausado={pausado} actorRef={actorRef} Muneco={Personaje} />, document.body)}
      {cafe &&
        createPortal(
          <>
            <div
              key={cafe.id}
              className="agente-cafe"
              data-fase={cafe.fase}
              data-saliendo={cafe.saliendo || undefined}
              data-oculto={pausado || undefined}
              aria-hidden
              style={{ left: cafe.x, top: cafe.y }}
            >
              <KioscoMonocolo />
              <div className="agente-cafe__letrero">MONÓCOLO</div>
            </div>
            {/* Viñeta del celular: la app de Monócolo y, de repente, el bug. */}
            {(cafe.fase === "app" || cafe.fase === "bug") && !cafe.saliendo && (
              <div
                key={cafe.fase}
                className="agente-manga agente-cafe__vineta"
                data-estilo={cafe.fase === "bug" ? "shock" : "gota"}
                data-oculto={pausado || undefined}
                aria-hidden
                style={{
                  left: Math.min(Math.max(8, cafe.pj.x - 80), window.innerWidth - 248),
                  top: Math.max(8, cafe.pj.y - 262),
                }}
              >
                {cafe.fase === "bug" && <div className="agente-manga__rayo" />}
                <AppMonocolo bug={cafe.fase === "bug"} />
                <span className="agente-manga__texto">{cafe.fase === "bug" ? "¡¡UN BUG CABRÓN!!" : "Pidiendo mi cafecito ☕"}</span>
              </div>
            )}
            {/* Globo de pensamiento: Toñito echando la weba en su moto. */}
            {cafe.fase === "tonito" && !cafe.saliendo && (
              <div
                className="agente-cafe__piensa"
                data-oculto={pausado || undefined}
                aria-hidden
                style={{
                  left: Math.min(Math.max(8, cafe.pj.x - 70), window.innerWidth - 228),
                  top: Math.max(8, cafe.pj.y - 240),
                }}
              >
                <div className="agente-cafe__nube"><Tonito /></div>
                <i className="agente-cafe__burbuja" />
                <i className="agente-cafe__burbuja agente-cafe__burbuja--2" />
              </div>
            )}
          </>,
          document.body,
        )}
      {pesca &&
        createPortal(
          <div
            key={pesca.id}
            className="agente-pesca"
            data-fase={pesca.fase}
            data-dir={pesca.dir}
            data-saliendo={pesca.saliendo || undefined}
            data-oculto={pausado || undefined}
            aria-hidden
            style={{ left: pesca.x, top: pesca.y }}
          >
            <svg viewBox={`0 0 ${PESCA_ANCHO} ${PESCA_ARRIBA + TAM}`} width={PESCA_ANCHO} height={PESCA_ARRIBA + TAM}>
              <ellipse className="agente-pesca__charco" cx="140" cy="104" rx="44" ry="7" />
              <ellipse className="agente-pesca__onda" cx="140" cy="104" rx="10" ry="2" />
              <ellipse className="agente-pesca__onda agente-pesca__onda--2" cx="140" cy="104" rx="10" ry="2" />
              <g className="agente-pesca__cana">
                <line x1="62" y1="74" x2="124" y2="22" />
                <circle cx="68" cy="69" r="3" />
              </g>
              <g className="agente-pesca__sedal">
                <path d="M124 22 Q 136 60 140 99" />
                <g className="agente-pesca__boya">
                  <circle cx="140" cy="100" r="3.2" fill="#f8fafc" />
                  <path d="M136.8 100 a3.2 3.2 0 0 1 6.4 0z" fill="#ef4444" />
                </g>
              </g>
            </svg>
            {pesca.presa && (pesca.fase === "jalando" || pesca.fase === "presume") && (
              <div
                key={pesca.lance}
                className="agente-pesca__presa"
                data-tipo={pesca.presa.tipo}
                data-adelante={pesca.presa.adelante || undefined}
              >
                <div className="agente-pesca__arco">
                  {pesca.presa.tipo === "pez" ? (
                    <Pez />
                  ) : (
                    <div className="agente-pesca__tarjeta">
                      <small>{pesca.presa.tipo === "ticket" ? "TICKET" : "PR"}</small>#{pesca.presa.num}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
      {pesca?.fase === "persecucion" &&
        createPortal(
          <div
            ref={pezRef}
            className="agente-pez"
            data-oculto={pausado || undefined}
            aria-hidden
            style={pesca.pez ? { transform: `translate3d(${pesca.pez.x}px, ${pesca.pez.y}px, 0) scaleX(${pesca.pez.dir})` } : undefined}
          >
            <div className="agente-pez__brinco"><Pez /></div>
          </div>,
          document.body,
        )}
      {maquina &&
        createPortal(
          <div
            key={maquina.id}
            className="agente-arcade"
            data-fase={maquina.fase}
            data-saliendo={maquina.saliendo || undefined}
            data-oculto={pausado || undefined}
            aria-hidden
            style={{ left: maquina.x, top: maquina.y }}
          >
            <div className="agente-arcade__marquesina">ARCADE</div>
            <div className="agente-arcade__pantalla">
              {maquina.fase === "jugando" && <i className="agente-arcade__juego" />}
              {maquina.fase === "gana" && <b>YOU WIN</b>}
              {(maquina.fase === "pierde" || maquina.fase === "patada") && <b>GAME OVER</b>}
              {maquina.fase === "rota" && <b>ERROR</b>}
            </div>
            <div className="agente-arcade__panel">
              <i className="agente-arcade__palanca" />
              <i className="agente-arcade__boton" />
              <i className="agente-arcade__boton" />
            </div>
            <div className="agente-arcade__ranura" />
            {(maquina.fase === "patada" || maquina.fase === "rota") && (
              <div className="agente-arcade__humo"><em /><em /><em /></div>
            )}
            {maquina.fase === "rota" && <div className="agente-arcade__chispas"><i>⚡</i><i>✦</i><i>⚡</i></div>}
          </div>,
          document.body,
        )}
      {pose === "victoria" && (
        <span className="agente-volador__claude-ok" aria-hidden>
          <b>✓</b><i>✦</i><i>✦</i><i>✦</i>
        </span>
      )}
      {pose === "pregunta" && <span className="agente-volador__claude-pregunta" aria-hidden>?</span>}
      {pose === "chispazo" && (
        <span className="agente-volador__claude-fallo" aria-hidden>
          <i>⚡</i><i>💥</i><i>⚡</i><em />
        </span>
      )}
      {mensajero && !pausado &&
        createPortal(
          <div
            className="agente-mensajero"
            data-fase={mensajero.fase}
            data-lado={mensajero.lado}
            style={{
              left: mensajero.x,
              top: mensajero.y,
              ["--desde" as string]: `${mensajero.lado === "izq" ? -(mensajero.x + TAM + 40) : window.innerWidth - mensajero.x + 40}px`,
            }}
            role="button"
            tabIndex={0}
            title={`Aviso de ${mensajero.deNombre}: clic para contestar`}
            onClick={(e) => {
              alertaRef.current?.apagar();
              alertaRef.current = null;
              onClick("avisos", mensajero.convId, e.currentTarget.getBoundingClientRect());
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              alertaRef.current?.apagar();
              alertaRef.current = null;
              onClick("avisos", mensajero.convId, e.currentTarget.getBoundingClientRect());
            }}
          >
            {/* Entra mirando hacia el propio; al irse se voltea. */}
            <div
              className="agente-mensajero__cuerpo"
              style={{ transform: `scaleX(${(mensajero.lado === "izq") === (mensajero.fase !== "sale") ? 1 : -1})` }}
            >
              <Personaje
                pose={mensajero.fase === "grita" ? "alerta" : "caminar"}
                animo={mensajero.fase === "grita" ? "grito" : "feliz"}
                skin={(SKINS.some((x) => x.id === mensajero.deSkin) ? mensajero.deSkin : skin) as Skin}
              />
            </div>
            <span className="agente-volador__gafete">{mensajero.deNombre}</span>
            {mensajero.fase === "grita" && (
              <span className="agente-volador__dialogo agente-mensajero__globo" data-tipo="grito">
                <b className="agente-mensajero__quien">{mensajero.deNombre}{mensajero.recordatorio ? " (sigue esperando)" : ""}</b>
                {mensajero.texto || "🔊 …"}
              </span>
            )}
          </div>,
          document.body,
        )}
      {llamando && pose === "alerta" && !pausado && (
        <span className="agente-volador__llamada" aria-hidden>
          <em /><em /><b>!</b>
        </span>
      )}
      {pose === "llorar" && (
        <span className="agente-volador__nube" aria-hidden>
          <i /><i /><i />
        </span>
      )}
      {dialogo && !pausado && !letrero && (
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
      <span className="agente-volador__globo">GeorgIA · Alt+K</span>
      <div ref={orientacion} className="agente-volador__orientacion">
        <div ref={inclinacion} className="agente-volador__inclinacion">
          <Personaje pose={pose === "rumbo" ? "caminar" : pose} animo={animo} snack={snack} vuelo={vuelo} calzones={calzones} />
          {enMano === "elote" && <span className="agente-volador__elote" aria-hidden>🌽</span>}
          {enMano && enMano !== "elote" && (
            <span className="agente-volador__mano" data-item={enMano} aria-hidden>
              {enMano === "cafe" ? "☕" : enMano === "termo" ? "🥤" : enMano === "bandera" ? "🇲🇽" : "🏏"}
            </span>
          )}
          {extra === "foco" && <span className="agente-volador__foco" aria-hidden>💡</span>}
          {extra === "venda" && <span className="agente-volador__venda" aria-hidden />}
          {pose === "enchilado" && <span className="agente-volador__orejas" aria-hidden><i>💨</i><i>💨</i></span>}
          {pose === "hadouken" && <span className="agente-volador__hadouken" aria-hidden />}
          {(cafe?.fase === "app" || cafe?.fase === "bug") && (
            <span className="agente-volador__cel" data-bug={cafe.fase === "bug" || undefined} aria-hidden />
          )}
        </div>
      </div>
      {/* Fuera de la orientación: no se voltea ni gira con el personaje. La key lo re-anima al cambiar. */}
      <span key={skin} className="agente-volador__gafete" aria-hidden>{nombre}</span>
    </button>
  );
}

/** Kiosco de MONÓCOLO (espresso, crema y dorado), en la caja de la escena del café. */
function KioscoMonocolo() {
  return (
    <svg viewBox={`92 0 ${CAFE_ANCHO} ${CAFE_ARRIBA + TAM}`} width={CAFE_ANCHO} height={CAFE_ARRIBA + TAM}>
      {/* Toldo a rayas con orilla de ondas. */}
      <rect x="96" y="22" width="80" height="12" fill="#EDE8DF" stroke="#2C2118" strokeWidth="1.5" />
      {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={96 + i * 16} y="22" width="8" height="12" fill="#2C2118" />)}
      <path
        d={`M96 34 ${"q4 6 8 0 ".repeat(10)}`}
        fill="#EDE8DF"
        stroke="#2C2118"
        strokeWidth="1.5"
      />
      {/* Cuerpo, ventanilla y mostrador. */}
      <rect x="100" y="40" width="72" height="64" fill="#EDE8DF" stroke="#2C2118" strokeWidth="1.5" />
      <rect x="106" y="46" width="60" height="26" rx="2" fill="#2C2118" />
      <rect x="96" y="72" width="80" height="6" fill="#B89B6E" stroke="#2C2118" strokeWidth="1.2" />
      <rect x="106" y="80" width="60" height="22" fill="#d8d0c4" stroke="#2C2118" strokeWidth="1" />
      {/* Vasito con vapor en el mostrador. */}
      <path d="M146 62 l2 10 h8 l2 -10z" fill="#f7f4ef" stroke="#2C2118" strokeWidth="1" />
      <rect x="146" y="60" width="12" height="3" rx="1" fill="#2C2118" />
      <path className="agente-cafe__vapor" d="M150 57 q-2 -3 0 -6 q2 -3 0 -6" fill="none" stroke="#f7f4ef" strokeWidth="1.2" strokeLinecap="round" />
      <path className="agente-cafe__vapor agente-cafe__vapor--2" d="M155 57 q-2 -3 0 -6 q2 -3 0 -6" fill="none" stroke="#f7f4ef" strokeWidth="1.2" strokeLinecap="round" />
      {/* Barista: solo la silueta en la ventanilla. */}
      <circle cx="122" cy="58" r="6" fill="#B89B6E" />
      <rect x="114" y="64" width="16" height="8" rx="3" fill="#B89B6E" />
    </svg>
  );
}

/** Pantalla del celular en la viñeta: la app de Monócolo y, con `bug`, el bicho que la truena. */
function AppMonocolo({ bug }: { bug: boolean }) {
  return (
    <div className="agente-cafe__app" data-bug={bug || undefined}>
      <div className="agente-cafe__app-barra">MONÓCOLO</div>
      <div className="agente-cafe__app-cuerpo">
        <div className="agente-cafe__app-item"><span>Latte de avena</span><b>$68</b></div>
        <div className="agente-cafe__app-item"><span>Cold brew</span><b>$62</b></div>
        <div className="agente-cafe__app-boton">{bug ? "ERROR 500" : "Pedir ahora"}</div>
      </div>
      {bug && <span className="agente-cafe__bicho">🐛</span>}
    </div>
  );
}

/** Lo que se imagina: Toñito (panzón) echando la weba, dando el rol en su chopper. */
function Tonito() {
  return (
    <svg viewBox="0 -8 170 100" width="170" height="100">
      <circle cx="12" cy="2" r="7" fill="#fde047" />
      <g className="agente-cafe__camino">
        <line x1="-20" y1="86" x2="190" y2="86" stroke="#94a3b8" strokeWidth="2" strokeDasharray="12 10" />
      </g>
      {/* Líneas de velocidad y humo del escape */}
      <g className="agente-cafe__velocidad" stroke="#cbd5e1" strokeWidth="1.5" strokeLinecap="round">
        <line x1="2" y1="40" x2="16" y2="40" />
        <line x1="6" y1="50" x2="22" y2="50" />
        <line x1="0" y1="60" x2="12" y2="60" />
      </g>
      <g className="agente-cafe__moto">
        <circle className="agente-cafe__humo" cx="14" cy="74" r="4" fill="#9ca3af" />
        <circle className="agente-cafe__humo agente-cafe__humo--2" cx="10" cy="72" r="3" fill="#cbd5e1" />
        {/* Llantas: la de atrás gorda; rines cromados */}
        <circle cx="42" cy="72" r="14" fill="#111827" />
        <circle cx="42" cy="72" r="7" fill="#e5e7eb" stroke="#9ca3af" strokeWidth="1.5" />
        <circle cx="132" cy="74" r="12" fill="#111827" />
        <circle cx="132" cy="74" r="6" fill="#e5e7eb" stroke="#9ca3af" strokeWidth="1.5" />
        {/* Escapes dobles cromados */}
        <path d="M70 70 L20 74" stroke="#d1d5db" strokeWidth="4" strokeLinecap="round" />
        <path d="M72 76 L22 79" stroke="#e5e7eb" strokeWidth="3.5" strokeLinecap="round" />
        {/* Salpicadera, chasis y horquilla larga de chopper */}
        <path d="M26 64 Q42 52 58 62" fill="none" stroke="#b91c1c" strokeWidth="4" strokeLinecap="round" />
        <path d="M42 72 L60 58 L96 58" fill="none" stroke="#374151" strokeWidth="3.5" strokeLinejoin="round" />
        <path d="M108 44 L132 74" stroke="#e5e7eb" strokeWidth="4.5" strokeLinecap="round" />
        {/* Motor V-twin con aletas */}
        <path d="M64 70 L68 52 L78 52 L76 70z" fill="#9ca3af" stroke="#4b5563" strokeWidth="1.2" />
        <path d="M76 70 L84 52 L94 54 L86 70z" fill="#9ca3af" stroke="#4b5563" strokeWidth="1.2" />
        <path d="M67 56 h10 M66 60 h10 M83 57 h9 M82 61 h9" stroke="#4b5563" strokeWidth="1" />
        {/* Tanque negro con flamas */}
        <path d="M74 50 Q80 38 98 40 Q110 42 108 50z" fill="#111827" />
        <path d="M80 48 Q84 42 88 46 Q90 40 95 44 Q98 41 102 46 L104 49z" fill="#f97316" />
        <path d="M84 49 Q87 45 90 48 Q93 44 97 48 L99 49z" fill="#facc15" />
        {/* Asiento bajo de piel */}
        <path d="M48 52 Q58 46 74 50 L72 56 H52z" fill="#78350f" />
        {/* Manubrio alto (ape hanger) y faro con luz */}
        <path d="M106 44 L110 24 L102 22" stroke="#111827" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M118 46 L170 36 L170 60z" fill="#fef9c3" opacity="0.6" />
        <circle cx="116" cy="48" r="4.5" fill="#fde68a" stroke="#9ca3af" strokeWidth="1.5" />
        {/* Toñito: panzón, gorra al revés, lentes oscuros y bigote, una mano en la nuca */}
        <path d="M58 50 L80 62 L92 66" stroke="#1e3a8a" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <ellipse cx="60" cy="36" rx="15" ry="16" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="1.5" />
        <ellipse cx="66" cy="42" rx="10" ry="9" fill="#f1f5f9" />
        <path d="M66 30 Q88 26 103 23" stroke="#e0a77a" strokeWidth="5.5" strokeLinecap="round" fill="none" />
        <path d="M54 26 Q44 18 52 8" stroke="#e0a77a" strokeWidth="5.5" strokeLinecap="round" fill="none" />
        <circle cx="62" cy="13" r="10.5" fill="#e0a77a" />
        <path d="M54 19 q8 6 16 0" stroke="#c98a5e" strokeWidth="1.5" fill="none" />
        <path d="M52 9 Q60 0 72 6 L76 8 L52 11z" fill="#dc2626" />
        <path d="M50 10 h-6" stroke="#dc2626" strokeWidth="3" strokeLinecap="round" />
        <rect x="60" y="10" width="13" height="4" rx="2" fill="#0f172a" />
        <path d="M62 17 q4 -2 9 0" stroke="#3f2a1d" strokeWidth="2" strokeLinecap="round" fill="none" />
      </g>
      <text className="agente-cafe__notas" x="82" y="12" fontSize="12">♪</text>
      <text x="104" y="6" fontSize="10" fontWeight="800" fill="#2C2118">Toñito 🏍️</text>
    </svg>
  );
}

/** Pez escurridizo, mirando a la derecha. */
function Pez() {
  return (
    <svg viewBox="0 0 28 16" width="28" height="16">
      <path d="M2 8 L-0 2 L7 6z M2 8 L0 14 L7 10z" fill="#ea580c" />
      <ellipse cx="15" cy="8" rx="11" ry="6" fill="#fb923c" />
      <path d="M12 3 Q15 0 19 3" fill="#ea580c" />
      <circle cx="21" cy="6.5" r="1.6" fill="#0f172a" />
      <path d="M25 9 q-1.5 1 -3 0.6" stroke="#9a3412" strokeWidth="0.8" fill="none" />
    </svg>
  );
}

/**
 * Dibujo de pie y mirando a la derecha; las poses las mueve personaje.css.
 * Proporciones de héroe: torso en V, extremidades que se adelgazan, todo con
 * curvas. Las articulaciones (hombros 38/58,39 · codo 58.1,51.6 · caderas
 * 45/52,63 · capa 48,37) están fijas: personaje.css gira sobre ellas.
 */
/** Dónde va el compañero de los avatares de dos (atrás y a la izquierda). */
const LUGAR_PAREJA: Partial<Record<Skin, string>> = {
  ricardo: "translate(-30 4) scale(0.94)",
  lilo: "translate(-22 22) scale(0.76)",
  ken: "translate(-32 3) scale(0.95)",
};

export function Personaje({ pose, animo = "serio", snack = null, vuelo = "superman", skin, calzones = false, anidado = false }: {
  pose: Pose;
  animo?: Animo;
  snack?: Snack | null;
  vuelo?: EstiloVuelo;
  /** Por omisión, la elegida en Configuración → GeorgIA. */
  skin?: Skin;
  /** Sin ropa, en calzones de corazones y descalzo (escena del oso). */
  calzones?: boolean;
  /** Es el compañero dibujado dentro del principal: las poses las toma del de afuera. */
  anidado?: boolean;
}) {
  const skinElegida = useSkinGeorgIA();
  const sk = skin ?? skinElegida;
  const pareja = anidado ? undefined : PAREJA[sk];
  const pal = PALETA[sk];
  // Vestido sin mangas: el brazo de atrás va con la piel.
  const manga = calzones || pal.brazosDescubiertos ? `url(#pj-piel-${sk})` : `url(#pj-camisa-${sk})`;
  const jean = calzones ? `url(#pj-piel-${sk})` : `url(#pj-jean-${sk})`;
  const piel = `url(#pj-piel-${sk})`;
  return (
    <svg
      viewBox="0 0 96 96"
      className={anidado ? "pj-pareja" : "agente-volador__sprite"}
      {...(anidado
        ? { width: 96, height: 96, overflow: "visible" }
        : { "data-pose": pose, "data-animo": animo, "data-snack": snack ?? undefined, "data-vuelo": vuelo, "data-skin": sk })}
      aria-hidden
    >
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
        <linearGradient id={`pj-piel-${sk}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={pal.piel[0]} />
          <stop offset="1" stopColor={pal.piel[1]} />
        </linearGradient>
        <linearGradient id="pj-bata" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e2e8f0" />
          <stop offset="0.5" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cbd5e1" />
        </linearGradient>
        <linearGradient id={`pj-camisa-${sk}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={pal.camisa[0]} />
          <stop offset="0.55" stopColor={pal.camisa[1]} />
          <stop offset="1" stopColor={pal.camisa[2]} />
        </linearGradient>
        <linearGradient id={`pj-jean-${sk}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={pal.pantalon?.[0] ?? "#1b3352"} />
          <stop offset="0.5" stopColor={pal.pantalon?.[1] ?? "#2b4f7a"} />
          <stop offset="1" stopColor={pal.pantalon?.[2] ?? "#172b45"} />
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

      {/* El compañero (Ricardo, Lilo, Ken): atrás, con la misma pose. */}
      {pareja && (
        <g transform={LUGAR_PAREJA[pareja]}>
          <Personaje pose={pose} animo={animo} vuelo={vuelo} skin={pareja} anidado />
        </g>
      )}
      <g className="agente-volador__cuerpo">
        {/* Capa: cae de los hombros con pliegues */}
        <g className="pj-capa">
          <path d="M39.5 36.5 C34 47 30.2 62 27.6 81.5 C32.5 78.6 37 82.4 41.6 79.8 C46 83 50.6 79.6 55.2 81.8 C56.6 66 57.6 51 57 36.5 Z" fill="url(#pj-capa-g)" />
          <path d="M37 46 C34.6 58 33.4 68 33 79" fill="none" stroke="#3f0707" strokeWidth="0.6" opacity="0.6" />
          <path d="M46 42 C45 56 44.6 68 45 80.6" fill="none" stroke="#3f0707" strokeWidth="0.6" opacity="0.5" />
        </g>

        {pal.cola && !calzones && <Cola tipo={pal.cola} skin={sk} />}

        {/* Brazo de atrás: manga arremangada y mano */}
        <g className="pj-brazo">
          {/* Brazo (hombro → codo) */}
          <path d="M35.4 38.6 C34.6 42.6 34.8 46.6 35.3 50.4 L40.5 50.4 C41 46.6 41.4 42.6 40.9 38.6 C39 37.2 37.2 37.2 35.4 38.6 Z" fill={manga} />
          <g className="pj-antebrazo-b">
          <circle cx="37.9" cy="49.8" r="2.6" fill={manga} />
          <path d="M35.4 49.6 C35.2 52.6 35.3 55 35.6 57.6 L40 57.6 C40.3 55 40.4 52.6 40.4 49.6 Z" fill={manga} />
          <path d="M35.3 55.6 C37 56.6 39 56.6 40.3 55.6 L40.1 58.2 C38.6 59 37 59 35.6 58.2 Z" fill={calzones || pal.brazosDescubiertos ? manga : "#6b727c"} />
          <path d="M35.8 58.4 C35.2 61.2 36.4 63.4 38.2 63.4 C40 63.4 41 61.4 40.4 58.4 Z" fill={pal.mano ?? `url(#pj-piel-${sk})`} />
          </g>
        </g>

        {/* Pierna de atrás */}
        <g className="pj-pierna-a">
          {/* Muslo */}
          <path d="M41.4 63 C40.9 67 41.1 71 41.7 74.8 L47.7 74.8 C48.4 71 48.9 67 48.8 63 Z" fill={jean} />
          <g className="pj-rodilla-a">
            {/* Espinilla + bota (gira sobre la rodilla) */}
            <ellipse cx="44.7" cy="74.4" rx="3.1" ry="1.9" fill={jean} />
            <path d="M41.9 74.2 C41.8 78 42 81 42.4 84 L47.2 84 C47.6 81 47.8 78 47.6 74.2 Z" fill={jean} />
            <path d="M42.2 83.2 C41.8 86 41.6 88.4 42.4 89.6 L49.8 89.6 C50.6 88.2 49.4 86.6 47.6 85.8 L47.4 83.2 Z" fill={calzones ? piel : pal.zapato ?? "#1c1917"} />
            <path d="M42.3 85 L47.5 85" stroke="#c99a3b" strokeWidth="0.6" />
          </g>
        </g>
        {/* Pierna de adelante */}
        <g className="pj-pierna-b">
          <path d="M48.4 63 C47.9 67 48.1 71 48.7 74.8 L54.7 74.8 C55.4 71 55.9 67 55.8 63 Z" fill={jean} />
          <g className="pj-rodilla-b">
            <ellipse cx="51.7" cy="74.4" rx="3.1" ry="1.9" fill={jean} />
            <path d="M48.9 74.2 C48.8 78 49 81 49.4 84 L54.2 84 C54.6 81 54.8 78 54.6 74.2 Z" fill={jean} />
            <path d="M49.2 83.2 C48.8 86 48.6 88.4 49.4 89.6 L56.8 89.6 C57.6 88.2 56.4 86.6 54.6 85.8 L54.4 83.2 Z" fill={calzones ? piel : pal.zapato ?? "#292524"} />
            <path d="M49.3 85 L54.5 85" stroke="#c99a3b" strokeWidth="0.6" />
          </g>
        </g>

        {/* Torso en V: hombros anchos, cintura angosta */}
        <path d="M36.2 37.4 C37.2 34.6 42 33.2 48 33.2 C54 33.2 58.8 34.6 59.8 37.4 C61 44.4 59.2 52.4 56.6 60.4 L39.4 60.4 C36.8 52.4 35 44.4 36.2 37.4 Z" fill={calzones ? piel : `url(#pj-camisa-${sk})`} />
        {calzones ? (
          <>
            {/* Ombligo, pancita y calzones de corazones */}
            <path d="M44 46 C46 47 50 47 52 46" fill="none" stroke={pal.pielSolida} strokeWidth="0.6" opacity="0.7" />
            <circle cx="48" cy="54" r="0.6" fill="#7c2d12" opacity="0.6" />
            <path d="M39 58.6 L57 58.6 L57.6 69.4 L49.2 69.4 L48 65.6 L46.8 69.4 L38.4 69.4 Z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.5" />
            {[[42, 62], [52, 61.4], [47.6, 60.4], [41.4, 66.8], [54.4, 66.4]].map(([x, y]) => (
              <path key={`${x}${y}`} d={`M${x} ${y + 0.8} l-1 -1 a0.6 0.6 0 0 1 1 -0.7 a0.6 0.6 0 0 1 1 0.7 z`} fill="#ef4444" />
            ))}
          </>
        ) : (
          <>
        <path d="M54 35 C57.6 42 57.6 52 55.4 60.2" fill="none" stroke="#4b5260" strokeWidth="0.5" opacity="0.5" />
        {/* Cuello de camisa */}
        {!pal.sinCuello && <path d="M43.6 34 L48 39.6 L46.2 34.4 Z M52.4 34 L48 39.6 L49.8 34.4 Z" fill="#6b727c" />}
        {!pal.faja && <path d="M48 39.6 L48 60" stroke="#565d68" strokeWidth="0.6" />}
        {/* Botones y emblema de engrane en el pecho (el saco de Ramón los tapa) */}
        {!pal.sinEmblema && [44, 49.5, 55].map((y) => <circle key={y} cx="48.9" cy={y} r="0.85" fill="#d4a446" />)}
        {!pal.sinEmblema && <g transform="translate(42.6 44.6)">
          <circle r="2.6" fill="url(#pj-laton)" />
          {[0, 45, 90, 135].map((a) => (
            <rect key={a} x="-0.7" y="-3.4" width="1.4" height="6.8" rx="0.4" fill="url(#pj-laton)" transform={`rotate(${a})`} />
          ))}
          <circle r="1.1" fill="#3f2a0b" />
        </g>}
        {/* Cinturón con hebilla (el vestido lleva faja de su tela) */}
        {pal.faja ? (
          <path d="M39.2 60 L56.8 60 L56.6 63.4 L39.4 63.4 Z" fill={pal.faja} />
        ) : (
          <>
            <path d="M39.2 60 L56.8 60 L56.6 63.4 L39.4 63.4 Z" fill="#292018" />
            <rect x="45.6" y="59.6" width="4.8" height="4.2" rx="1" fill="url(#pj-laton)" stroke="#5c3d0f" strokeWidth="0.4" />
          </>
        )}

        {sk === "cientifico" && <Bata />}
        {sk === "ramon" && <Saco />}
        {sk === "tomaso" && <Saco camisa="#f8fafc" cuello="#ffffff" solapa="#4b5563" boton="#1f2937" />}
        {sk === "licesita" && <Vestido skin={sk} />}
        {sk === "keity" && <Blusa skin={sk} />}
        {sk === "abel" && <Camisa skin={sk} />}
        {sk === "pablo" && <Saco camisa="#f8fafc" cuello="#ffffff" solapa="#57534e" boton="#292524" />}
        {sk === "rodrigo" && <Saco camisa="#f8fafc" cuello="#ffffff" solapa="#0f172a" boton="#0f172a" corbata="#1e3a8a" />}
        {sk === "manuel" && <Saco camisa="#1f2937" cuello="#111827" solapa="#030712" boton="#111827" />}
        {(sk === "ryu" || sk === "ken") && <Gi skin={sk} />}
        {sk === "lilo" && <HojasVestido />}
        {sk === "linguini" && <Filipina />}
        {(sk === "cotorrisa" || sk === "ricardo") && <Playera skin={sk} />}
        {sk === "cantinflas" && <Camiseta skin={sk} />}
        {sk === "homero" && <Camisa skin={sk} />}
          </>
        )}
        {sk === "cyborg" ? (
          <>
        {/* Cuello mecánico con cables */}
        <path d="M45 29.4 C45 32 44.6 34 44.2 35.6 L51.8 35.6 C51.4 34 51 32 51 29.4 Z" fill="url(#pj-metal)" />
        <path d="M46 31 C47.6 31.8 48.6 31.8 50 31 M45.6 33.2 C47.4 34 48.8 34 50.4 33.2" fill="none" stroke="#d4a446" strokeWidth="0.6" />

        <g className="pj-cabeza">
        {/* Cabeza: mandíbula marcada, nariz larga */}
        <path d="M41 16 C41 9.4 45.4 6.6 50 6.8 C55.4 7.1 58.6 10.8 58.7 15.6 C58.8 18.4 61.6 20.6 61.4 22.8 C61.2 24.6 59.2 24.8 58.8 26 C58.2 29.6 55.6 31.8 52 32 C47.6 32.2 43.6 30.2 42.1 26.6 C40.7 23.4 41 19.6 41 16 Z" fill={`url(#pj-piel-${sk})`} />
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
        {/* Antojos: masticando, sorbiendo el popote, lamiendo */}
        <g className="pj-boca pj-boca--come"><ellipse className="pj-masca" cx="56" cy="28.4" rx="1.7" ry="1.1" fill="#3b0f0a" /></g>
        <circle className="pj-boca pj-boca--sorbe" cx="56.6" cy="28.3" r="0.95" fill="#7f1d1d" stroke="#c2706b" strokeWidth="0.6" />
        <g className="pj-boca pj-boca--lame">
          <ellipse cx="56" cy="28.2" rx="1.6" ry="1" fill="#3b0f0a" />
          <path className="pj-lengua" d="M55.6 28.6 C56.2 31 58.2 31 58.4 29 Z" fill="#f472b6" />
        </g>
        {/* Llanto: ceja triste, boca quebrada y lágrimas que caen */}
        <path className="pj-ceja pj-ceja--triste" d="M50.8 17 C52.6 17.2 55 18.2 57.2 19.4" fill="none" stroke="#111827" strokeWidth="1.6" strokeLinecap="round" />
        <path className="pj-boca pj-boca--llora" d="M53.6 29.4 C54.4 27.8 55.4 28.6 56 27.9 C56.6 28.6 57.4 27.8 58.2 29.4" fill="none" stroke="#6b3a24" strokeWidth="1" strokeLinecap="round" />
        <g className="pj-lagrimas">
          <path className="pj-lagrima" d="M54.8 22.2 C54 23.6 54 24.6 54.8 24.8 C55.6 24.6 55.6 23.6 54.8 22.2 Z" fill="#7dd3fc" />
          <path className="pj-lagrima pj-lagrima--2" d="M53.2 22.4 C52.4 23.8 52.4 24.8 53.2 25 C54 24.8 54 23.8 53.2 22.4 Z" fill="#bae6fd" />
        </g>
        {/* Pelo: copete peinado hacia atrás */}
        <path d="M40.4 18 C38.2 10.6 41.2 4.2 48.6 3.4 C55.4 2.6 61 6.2 60.2 12 C58 9.4 54.6 8.6 50.8 9.4 C46.4 10.4 43.4 12.8 42.4 18.6 Z" fill="#111827" />
        <path d="M43 9 C46 5.8 51.4 4.8 56.4 6.6" fill="none" stroke="#4b5563" strokeWidth="0.8" strokeLinecap="round" />
        {/* Goggles de latón */}
        <path d="M40.6 13.6 C46 11.4 53 11 59.6 12.6 L59.4 15.2 C53 13.8 46.2 14.2 40.9 16.4 Z" fill="url(#pj-laton)" />
        <circle cx="48.6" cy="12.6" r="3.6" fill="url(#pj-laton)" />
        <circle cx="48.6" cy="12.6" r="2.4" fill="url(#pj-cristal)" />
        <circle cx="55.8" cy="12.4" r="3.6" fill="url(#pj-laton)" />
        <circle cx="55.8" cy="12.4" r="2.4" fill="url(#pj-cristal)" />

        </g>
          </>
        ) : (
          <CabezaCartoon skin={sk} />
        )}

        {sk === "cyborg" ? (
          <>
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
            <Antojos />
          </g>
        </g>
          </>
        ) : (
          <BrazoHumano skin={sk} desnudo={calzones} />
        )}
      </g>
    </svg>
  );
}
