import { GraphViewer } from "@/components/GraphViewer";

export function GraphPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="px-6 pt-6 pb-2 shrink-0">
        <h1 className="text-2xl font-bold">Grafo de Conocimiento</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Red neuronal de sozu-docs — entidades, relaciones y comunidades detectadas por Graphify
        </p>
      </div>
      <div className="flex-1 overflow-hidden">
        <GraphViewer />
      </div>
    </div>
  );
}
