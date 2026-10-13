import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Empresa elegida en la navegación, compartida entre Resumen y CI/CD.
//
// Vive en `sessionStorage` porque es una decisión de navegación, no un dato: si
// estás mirando Vectis en el Resumen y pasas a CI/CD, sigues en Vectis. Perderla
// al cambiar de pestaña obligaba a re-elegir empresa todo el tiempo.
//
// `null` = todas. La clave es fija (una sola empresa activa a la vez, no una por
// pantalla) justo para que las dos pantallas coincidan.
// ---------------------------------------------------------------------------

const CLAVE = "empresa-activa";

const EVENTO_EMPRESA = "dashboard:empresa-activa";

export function useEmpresaActiva() {
  const [empresa, setEmpresa] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(CLAVE);
    } catch {
      return null;
    }
  });

  // Varias partes la leen a la vez (la pantalla y el vigía de GeorgIA, que solo
  // avisa de los repos de la empresa elegida): al cambiarla, todas se enteran.
  useEffect(() => {
    const alCambiar = (e: Event) => setEmpresa((e as CustomEvent<string | null>).detail ?? null);
    window.addEventListener(EVENTO_EMPRESA, alCambiar);
    return () => window.removeEventListener(EVENTO_EMPRESA, alCambiar);
  }, []);

  const elegir = useCallback((id: string | null) => {
    try {
      if (id === null) sessionStorage.removeItem(CLAVE);
      else sessionStorage.setItem(CLAVE, id);
    } catch {
      // Sin sessionStorage la elección solo dura lo que dure la pantalla.
    }
    setEmpresa(id);
    window.dispatchEvent(new CustomEvent<string | null>(EVENTO_EMPRESA, { detail: id }));
  }, []);

  return { empresa, elegir };
}
