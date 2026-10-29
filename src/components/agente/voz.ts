/**
 * Voz de los avatares con la síntesis del navegador (gratis, sin servicios):
 * cada personaje se distingue por tono, velocidad y voz de hombre o mujer. Solo
 * habla para quien tiene el permiso «Voz del avatar». En los avatares de dos,
 * la línea que empieza con el nombre del compañero («Ricardo: …») la dice el
 * compañero con su voz, sin leer el nombre.
 */
import type { Skin } from "./skinsDatos";

type Voz = { tono: number; velocidad: number; genero: "h" | "m" };

const VOZ: Partial<Record<Skin, Voz>> = {
  cyborg: { tono: 0.6, velocidad: 0.95, genero: "h" },
  abuelo: { tono: 0.8, velocidad: 0.85, genero: "h" },
  heroe: { tono: 0.9, velocidad: 1, genero: "h" },
  chibi: { tono: 1.9, velocidad: 1.15, genero: "m" },
  cientifico: { tono: 1.2, velocidad: 1.2, genero: "h" },
  raton: { tono: 2, velocidad: 1.1, genero: "h" },
  travieso: { tono: 1.5, velocidad: 1.1, genero: "h" },
  licesita: { tono: 1.15, velocidad: 1, genero: "m" },
  keity: { tono: 1.05, velocidad: 1, genero: "m" },
  cotorrisa: { tono: 0.95, velocidad: 1.1, genero: "h" },
  ricardo: { tono: 1.1, velocidad: 1.1, genero: "h" },
  cantinflas: { tono: 1.1, velocidad: 1.3, genero: "h" },
  pantera: { tono: 0.7, velocidad: 0.8, genero: "h" },
  dino: { tono: 0.3, velocidad: 0.8, genero: "h" },
  homero: { tono: 0.6, velocidad: 0.9, genero: "h" },
  stitch: { tono: 1.7, velocidad: 1.2, genero: "h" },
  lilo: { tono: 1.6, velocidad: 1.05, genero: "m" },
  linguini: { tono: 1.1, velocidad: 1.05, genero: "h" },
  ryu: { tono: 0.85, velocidad: 1, genero: "h" },
  ken: { tono: 1.05, velocidad: 1.1, genero: "h" },
};
const VOZ_DEFAULT: Voz = { tono: 1, velocidad: 1, genero: "h" };

/** Quién dice cada línea de los de dos (por el prefijo «Nombre:»). */
const HABLANTES: Record<string, Skin> = {
  slobo: "cotorrisa", ricardo: "ricardo", lilo: "lilo", stitch: "stitch", remy: "linguini", linguini: "linguini", ryu: "ryu", ken: "ken",
};

const MUJER = /paulina|m[oó]nica|helena|laura|sabina|marisol|luc[ií]a|elvira|dalia|camila|female|mujer|google español de estados unidos/i;
const HOMBRE = /jorge|juan|diego|carlos|pablo|ra[uú]l|enrique|jorge|male|hombre|google español$/i;

function vozDelSistema(genero: Voz["genero"]): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const es = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("es"));
  if (!es.length) return null;
  const mx = es.filter((v) => /mx|419|us/i.test(v.lang));
  const pool = mx.length ? mx : es;
  const patron = genero === "m" ? MUJER : HOMBRE;
  return pool.find((v) => patron.test(v.name)) ?? es.find((v) => patron.test(v.name)) ?? pool[0];
}

let calladoHasta = 0;
/** No hablar por un rato (mientras suena el audio de un aviso). */
export function callarVoz(ms: number) {
  calladoHasta = Date.now() + ms;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/** Lo que no se lee en voz alta: emojis y acotaciones entre paréntesis. */
const limpiar = (t: string) =>
  t.replace(/\([^)]*\)/g, " ").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ").replace(/\s+/g, " ").trim();

export function hablar(texto: string, skin: Skin) {
  if (typeof speechSynthesis === "undefined" || Date.now() < calladoHasta) return;
  let quien = skin;
  let linea = texto;
  const m = texto.match(/^\s*([A-Za-zÁÉÍÓÚáéíóú]+):\s*(.*)$/);
  if (m && HABLANTES[m[1].toLowerCase()]) {
    quien = HABLANTES[m[1].toLowerCase()];
    linea = m[2];
  }
  const dicho = limpiar(linea);
  if (!dicho || /^[.…\s]+$/.test(dicho)) return;
  // Chrome en Android a veces deja la síntesis en pausa.
  speechSynthesis.resume();
  const v = VOZ[quien] ?? VOZ_DEFAULT;
  const u = new SpeechSynthesisUtterance(dicho);
  u.lang = "es-MX";
  u.pitch = v.tono;
  u.rate = v.velocidad;
  const sistema = vozDelSistema(v.genero);
  if (sistema) u.voice = sistema;
  // Una a la vez: la nueva corta a la anterior. Chrome a veces se traga la
  // línea si se habla justo después de cancelar: se le da un respiro.
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    setTimeout(() => speechSynthesis.speak(u), 60);
  } else speechSynthesis.speak(u);
}

// Las voces cargan en segundo plano: pedirlas desde el inicio para que la
// primera línea ya salga con la voz en español y no con la del sistema.
if (typeof speechSynthesis !== "undefined") {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener?.("voiceschanged", () => speechSynthesis.getVoices());
}

/**
 * Celular: Safari (iOS) y Chrome (Android) no dejan hablar ni sonar audio si la
 * primera vez no fue dentro de un toque. Al primer toque en la página se dice
 * una línea muda y se reproduce silencio en un <audio> que se reutiliza para
 * los avisos: desde ahí ya pueden sonar solos.
 */
const SILENCIO = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
const audioCompartido: HTMLAudioElement | null = typeof Audio !== "undefined" ? new Audio() : null;
let desbloqueado = false;
const EVENTOS_TOQUE = ["pointerdown", "touchend", "keydown"] as const;
function desbloquear() {
  if (desbloqueado) return;
  desbloqueado = true;
  for (const ev of EVENTOS_TOQUE) window.removeEventListener(ev, desbloquear, true);
  try {
    if (typeof speechSynthesis !== "undefined") {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch { /* sin síntesis */ }
  if (audioCompartido && !audioCompartido.src) {
    audioCompartido.src = SILENCIO;
    void audioCompartido.play().then(() => audioCompartido.pause()).catch(() => {});
  }
}
if (typeof window !== "undefined") {
  for (const ev of EVENTOS_TOQUE) window.addEventListener(ev, desbloquear, { capture: true, passive: true });
}

/** <audio> para el audio de un aviso: el mismo que se desbloqueó con el primer toque. */
export function audioDeAviso(src: string): HTMLAudioElement {
  if (!audioCompartido) return new Audio(src);
  audioCompartido.pause();
  audioCompartido.onended = null;
  audioCompartido.onloadedmetadata = null;
  audioCompartido.src = src;
  audioCompartido.preload = "auto";
  audioCompartido.load();
  return audioCompartido;
}

/**
 * Botón «Probar voz»: habla dentro del clic (así también desbloquea el celular)
 * y dice qué pasó, para saber por qué no se oye en un equipo.
 */
export function probarVoz(skin: Skin): Promise<string> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve("Este navegador no tiene voz (síntesis de voz).");
  desbloquear();
  const voces = speechSynthesis.getVoices();
  const es = voces.filter((v) => v.lang.toLowerCase().startsWith("es")).length;
  const v = VOZ[skin] ?? VOZ_DEFAULT;
  const u = new SpeechSynthesisUtterance("¡Hola! Así sueno.");
  u.lang = "es-MX";
  u.pitch = v.tono;
  u.rate = v.velocidad;
  const sistema = vozDelSistema(v.genero);
  if (sistema) u.voice = sistema;
  calladoHasta = 0;
  speechSynthesis.cancel();
  speechSynthesis.resume();
  const datos = `${voces.length} voces, ${es} en español${sistema ? ` (usa «${sistema.name}»)` : ""}`;
  return new Promise((ok) => {
    const t = setTimeout(() => ok(`No arrancó: el navegador no reprodujo nada. ${datos}. Revisa el volumen y, en iPhone, el switch de silencio.`), 4000);
    u.onstart = () => { clearTimeout(t); ok(`Sí habló. ${datos}.`); };
    u.onerror = (e) => { clearTimeout(t); ok(`Falló (${e.error}). ${datos}.`); };
    speechSynthesis.speak(u);
  });
}
