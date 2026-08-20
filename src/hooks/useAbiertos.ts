import { useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// Plegado de las tarjetas de Configuración.
//
// Las pantallas de esta sección crecen con la cartera: cuatro empresas de
// notificaciones, cada una con tres campos y su historial, ya obligaban a
// scrollear para llegar a la última. Con todo abierto no se puede comparar dos
// empresas ni encontrar la que se venía a tocar.
//
// El estado vive en un `Set` de ids abiertos —no un "id abierto" suelto— porque
// comparar dos empresas es justo lo que no se podía hacer antes. Y arranca
// cerrado: la cabecera de cada tarjeta ya dice lo importante (nombre, si manda
// avisos, cuántos repos), así que abrir es para editar.
// ---------------------------------------------------------------------------

export function useAbiertos(inicial: string[] = []) {
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set(inicial));
  const alternar = useCallback((id: string) => {
    setAbiertos((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const abrirTodos = useCallback((ids: string[]) => setAbiertos(new Set(ids)), []);
  const cerrarTodos = useCallback(() => setAbiertos(new Set()), []);
  return { abiertos, alternar, abrirTodos, cerrarTodos };
}

