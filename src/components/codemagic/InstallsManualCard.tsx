import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setProjectInstallsManual, type Project } from "@/lib/firestoreProjects";

// ---------------------------------------------------------------------------
// Descargas leídas A MANO de las consolas.
//
// Las fuentes automáticas van por detrás de la realidad y no hay forma de
// arreglarlo desde aquí: Google Play publica un informe por mes CERRADO —en
// septiembre lo más nuevo es agosto— y Apple tarda días en generar los suyos
// la primera vez. Mientras tanto la tarjeta enseñaba 10 descargas de una app
// que Play Console ya daba por 17 y App Store Connect por 43, o sea que el
// dashboard contradecía a la fuente oficial.
//
// Con esto se teclea lo que dice la consola hoy y la tarjeta deja de mentir.
// Es un PISO, no un sustituto: por plataforma gana el número más alto entre lo
// automático y esto, y nunca se suman —serían los mismos usuarios dos veces—.
// ---------------------------------------------------------------------------

export function InstallsManualCard({ project, email }: { project: Project; email: string }) {
  const qc = useQueryClient();
  const guardado = project.installsManual;
  const [android, setAndroid] = useState(guardado?.android?.toString() ?? "");
  const [ios, setIos] = useState(guardado?.ios?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState("");

  const guardar = async () => {
    setBusy(true);
    setError("");
    try {
      await setProjectInstallsManual(
        project.id,
        {
          android: android.trim() ? Number(android.trim()) : null,
          ios: ios.trim() ? Number(ios.trim()) : null,
        },
        email,
      );
      await qc.invalidateQueries({ queryKey: ["projects"] });
      setOk(true);
      window.setTimeout(() => setOk(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  };

  const campo = (
    valor: string,
    set: (v: string) => void,
    etiqueta: string,
    ayuda: string,
  ) => (
    <label className="flex items-center gap-1.5" title={ayuda}>
      <span className="text-[10px] text-muted-foreground">{etiqueta}</span>
      <input
        inputMode="numeric"
        value={valor}
        onChange={(e) => set(e.target.value.replace(/[^\d]/g, ""))}
        placeholder="—"
        className="h-6 w-20 rounded border bg-background px-1.5 text-right font-mono text-[11px]"
      />
    </label>
  );

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-dashed px-3 py-2">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Download className="h-3 w-3" />
        Descargas según la consola
      </span>
      <span className="w-full text-[10px] text-muted-foreground/70">
        Lo que hoy dicen Play Console y App Store Connect. La tarjeta lo usa mientras el dato
        automático va por detrás —Play publica su informe al cierre del mes— y lo deja de usar en
        cuanto el automático lo supera.
      </span>
      {project.androidPackage &&
        campo(android, setAndroid, "Play", "Usuarios con la app instalada, según Play Console")}
      {project.iosBundleId &&
        campo(ios, setIos, "App Store", "Descargas totales según App Store Connect → Análisis")}
      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy} onClick={guardar}>
        {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : ok ? <Check className="mr-1 h-3 w-3" /> : null}
        {ok ? "guardado" : "guardar"}
      </Button>
      {guardado?.fecha && (
        <span className="text-[10px] text-muted-foreground/70">
          leído el {guardado.fecha}
          {guardado.actualizadoPor ? ` por ${guardado.actualizadoPor}` : ""}
        </span>
      )}
      {error && <span className="text-[10px] text-destructive">{error}</span>}
    </div>
  );
}
