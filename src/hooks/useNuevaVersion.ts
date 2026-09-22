import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// ¿Hay una versión más nueva publicada que la que tiene esta pestaña?
//
// El dashboard se despliega varias veces al día. Una pestaña abierta se queda
// con el JS que cargó, y eso ya ha costado dos confusiones caras: un "no se
// pudo cargar la página" que era un chunk viejo pidiendo archivos que ya no
// existían, y un arreglo que "no funcionaba" porque la pestaña seguía en el
// build anterior. En los dos casos el tablero tenía razón y la pestaña no.
//
// Se compara el nombre del bundle —que lleva un hash del contenido— entre el
// `index.html` publicado y el que esta pestaña cargó. Si difieren, hay versión
// nueva. No hace falta un endpoint ni un número de versión: el hash ya cambia
// exactamente cuando cambia el código.
// ---------------------------------------------------------------------------

const CADA_MS = 3 * 60_000;

/** El bundle que cargó ESTA pestaña, leído del propio documento. */
function bundleActual(): string | null {
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]',
  );
  return script ? new URL(script.src, location.href).pathname : null;
}

/** El bundle que sirve el sitio ahora mismo. */
async function bundlePublicado(): Promise<string | null> {
  // `no-store` y una marca de tiempo: sin las dos, el navegador contesta con el
  // index que tiene guardado y la comprobación no comprueba nada.
  const r = await fetch(`/index.html?v=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return null;
  const html = await r.text();
  return html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

export function useNuevaVersion(): boolean {
  const [hayNueva, setHayNueva] = useState(false);

  useEffect(() => {
    const actual = bundleActual();
    // En desarrollo no hay bundle con hash: no hay nada que comparar.
    if (!actual) return;

    let vivo = true;
    const mirar = async () => {
      try {
        const publicado = await bundlePublicado();
        if (vivo && publicado && publicado !== actual) setHayNueva(true);
      } catch {
        // Sin red o con el sitio caído no se afirma nada: avisar de una versión
        // nueva porque falló una petición sería mentir en el peor momento.
      }
    };

    mirar();
    const t = setInterval(mirar, CADA_MS);
    // Al volver a la pestaña también: es justo cuando alguien retoma una
    // ventana que llevaba horas abierta, que es el caso que duele.
    const alVolver = () => document.visibilityState === "visible" && mirar();
    document.addEventListener("visibilitychange", alVolver);

    return () => {
      vivo = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, []);

  return hayNueva;
}
