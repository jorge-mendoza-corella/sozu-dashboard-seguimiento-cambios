import * as Tooltip from "@radix-ui/react-tooltip";

/**
 * Tooltip de ayuda (qué hace un botón o un permiso). El disparador va en un
 * span: un botón deshabilitado no recibe el mouse y el tooltip no saldría.
 */
export function AyudaTooltip({ texto, children }: { texto: React.ReactNode; children: React.ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="inline-flex">{children}</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-[70] max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
          >
            {texto}
            <Tooltip.Arrow className="fill-popover" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
