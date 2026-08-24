import { GitMerge, Radio, User, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FichaPersona } from "@/hooks/useAvisos";

// ---------------------------------------------------------------------------
// Un destinatario de aviso, con su papel y su ficha.
//
// La línea decía "Avisó a @Eddys912, @infexiuz, @jorgeIMendoza,
// @jorge-mendoza-corella" y ahí terminaba: cuatro logins sin decir quién es
// quién ni por qué está cada uno. Para revisar un deploy hay que saber si al
// aprobador le llegó, no si le llegó a cuatro cuentas.
//
// Cada nombre lleva ahora el icono de su papel —autor, aprobador, quien
// mergeó, suscrito— y su ficha en el tooltip: correo, teléfono y rol. El
// teléfono importa especialmente: sale de Contribuidores, que es de donde lo
// toman los workflows, así que un nombre sin teléfono en la ficha explica por
// sí solo un aviso que nunca llegó.
// ---------------------------------------------------------------------------

export type Papel = "autor" | "aprobador" | "mergeo" | "suscrito" | "disparo";

const PAPEL: Record<Papel, { icono: typeof User; texto: string; color: string }> = {
  autor:     { icono: User,      texto: "autor de los cambios",        color: "text-sky-600 dark:text-sky-400" },
  aprobador: { icono: UserCheck, texto: "aprobador del proyecto",      color: "text-emerald-600 dark:text-emerald-400" },
  mergeo:    { icono: GitMerge,  texto: "hizo el merge",               color: "text-violet-600 dark:text-violet-400" },
  suscrito:  { icono: Radio,     texto: "suscrito a todos los repos",  color: "text-amber-600 dark:text-amber-400" },
  disparo:   { icono: Radio,     texto: "disparó el deploy",           color: "text-sky-600 dark:text-sky-400" },
};

/** Una persona puede ser varias cosas a la vez: autor Y quien mergeó. */
export function Avisado({ login, papeles, ficha, sobreFondoOscuro = false }: {
  login: string;
  papeles: Papel[];
  ficha?: FichaPersona;
  sobreFondoOscuro?: boolean;
}) {
  const orden: Papel[] = ["disparo", "autor", "aprobador", "mergeo", "suscrito"];
  const suyos = orden.filter((p) => papeles.includes(p));

  const titulo = [
    `@${login}`,
    ...(ficha?.email ? [ficha.email] : []),
    ...(ficha?.rol ? [ficha.rol] : []),
    ficha?.telefono
      ? `tel. ${ficha.telefono}`
      : "SIN TELÉFONO en Contribuidores — no puede recibir avisos",
    ...(suyos.length ? [suyos.map((p) => PAPEL[p].texto).join(" · ")] : []),
  ].join("\n");

  return (
    <span
      title={titulo}
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1 font-mono",
        sobreFondoOscuro ? "hover:bg-white/15" : "hover:bg-muted",
        // Sin teléfono no le va a llegar nada aunque esté en la lista: se
        // subraya en punteado para que se note sin gritar.
        !ficha?.telefono && "underline decoration-dotted underline-offset-2",
      )}
    >
      {suyos.map((p) => {
        const { icono: Icono, color } = PAPEL[p];
        return (
          <Icono
            key={p}
            className={cn("h-3 w-3 shrink-0", sobreFondoOscuro ? "text-white/80" : color)}
            aria-hidden
          />
        );
      })}
      @{login}
    </span>
  );
}
