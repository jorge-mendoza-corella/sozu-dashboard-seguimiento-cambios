/**
 * Pitidos cortos generados con WebAudio (sin archivos de audio).
 *
 * El navegador solo deja sonar audio después de que la persona interactuó con
 * la página; si todavía no, el pitido simplemente no suena (no truena).
 */
let ctx: AudioContext | null = null;

function contexto(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function nota(c: AudioContext, frecuencia: number, inicio: number, duracion: number, volumen = 0.18) {
  const osc = c.createOscillator();
  const gan = c.createGain();
  osc.type = "sine";
  osc.frequency.value = frecuencia;
  // Entrada y salida suaves: sin el "clic" de cortar la onda en seco.
  gan.gain.setValueAtTime(0, inicio);
  gan.gain.linearRampToValueAtTime(volumen, inicio + 0.015);
  gan.gain.exponentialRampToValueAtTime(0.0001, inicio + duracion);
  osc.connect(gan).connect(c.destination);
  osc.start(inicio);
  osc.stop(inicio + duracion + 0.02);
}

/** Dos tonos ascendentes: "terminó bien". Tres más graves si `tipo` es "pregunta" o "error". */
export function pitido(tipo: "listo" | "pregunta" | "error" = "listo") {
  const c = contexto();
  if (!c) return;
  const t = c.currentTime + 0.02;
  if (tipo === "listo") {
    nota(c, 880, t, 0.16);
    nota(c, 1320, t + 0.17, 0.28);
  } else if (tipo === "pregunta") {
    nota(c, 660, t, 0.14);
    nota(c, 880, t + 0.16, 0.14);
    nota(c, 660, t + 0.32, 0.24);
  } else {
    nota(c, 440, t, 0.2);
    nota(c, 330, t + 0.22, 0.32);
  }
}
