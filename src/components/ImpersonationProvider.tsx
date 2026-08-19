import { useCallback, useMemo, useState } from "react";
import { CLAVE_IMPERSONACION, ImpersonacionCtx } from "@/hooks/useImpersonation";

/**
 * Guarda a qué usuario está "viendo como" el root. Vive en `sessionStorage`:
 * sobrevive a un F5 —perderlo en cada recarga hace la función inútil— pero no
 * se queda pegado para la próxima sesión.
 */
export function ImpersonationProvider({ children }: { children: React.ReactNode }) {
  const [email, setEmail] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(CLAVE_IMPERSONACION);
    } catch {
      return null;
    }
  });

  const ver = useCallback((correo: string) => {
    try {
      sessionStorage.setItem(CLAVE_IMPERSONACION, correo);
    } catch {
      // Sin sessionStorage (modo privado estricto) se pierde al recargar, pero
      // la sesión en curso funciona igual.
    }
    setEmail(correo);
  }, []);

  const salir = useCallback(() => {
    try {
      sessionStorage.removeItem(CLAVE_IMPERSONACION);
    } catch {
      // idem
    }
    setEmail(null);
  }, []);

  const valor = useMemo(() => ({ email, ver, salir }), [email, ver, salir]);
  return <ImpersonacionCtx.Provider value={valor}>{children}</ImpersonacionCtx.Provider>;
}
