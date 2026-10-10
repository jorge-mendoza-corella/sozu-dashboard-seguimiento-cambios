/**
 * Diálogo para esconder al personaje: él mismo ruega que no lo manden a dormir.
 * Solo se esconde si se confirma; el chat sigue disponible con Alt+K.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Personaje } from "./AgenteVolador";

const RUEGOS = [
  "¡Oye, no mames! ¿A dónde me vas a mandar?",
  "¿Neta me vas a apagar? Yo que te cuido los deploys…",
  "¡Ah, caray! ¿Y quién te va a gritar por los tickets?",
  "Snif… ¿tan molesto soy? No me contestes.",
  "¡Ni madres! Bueno… si insistes.",
];

export function ConfirmarApagarAgentito({ abierto, onCancelar, onConfirmar }: {
  abierto: boolean;
  onCancelar: () => void;
  onConfirmar: () => void;
}) {
  // Se monta solo al abrirse (ver AgenteAccesoSection): una súplica distinta cada vez.
  const [ruego] = useState(() => RUEGOS[Math.floor(Math.random() * RUEGOS.length)]);
  return (
    <Dialog.Root open={abierto} onOpenChange={(v) => !v && onCancelar()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          // Centrado con inset + margin auto: la animación de entrada usa transform y pisaría un translate.
          className="fixed inset-0 z-50 m-auto h-fit w-[min(420px,calc(100vw-32px))] rounded-2xl border bg-background p-5 shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
        >
          <div className="flex items-end gap-3">
            <div className="h-28 w-28 shrink-0">
              <Personaje pose="alerta" animo="grito" />
            </div>
            <p className="relative mb-6 rounded-2xl border-2 border-amber-600 bg-amber-50 px-3 py-2 text-sm font-bold text-red-900 dark:bg-amber-950/60 dark:text-amber-100">
              {ruego}
            </p>
          </div>
          <Dialog.Title className="mt-3 text-base font-semibold">¿Esconder al agentito?</Dialog.Title>
          <p className="mt-1 text-sm text-muted-foreground">
            Deja de volar por la pantalla y no te grita por los tickets ni festeja deploys. El chat sigue en
            <kbd className="mx-1 rounded border px-1 text-[11px]">Alt</kbd>+<kbd className="mx-1 rounded border px-1 text-[11px]">K</kbd>
            y lo puedes volver a prender aquí mismo.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onCancelar} className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted">
              No, quédate
            </button>
            <button type="button" onClick={onConfirmar} className="h-9 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground">
              Sí, vete a dormir
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
