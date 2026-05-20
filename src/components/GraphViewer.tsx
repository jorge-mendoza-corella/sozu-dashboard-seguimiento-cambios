import { useEffect, useRef, useState, useMemo } from "react";
import cytoscape from "cytoscape";
// @ts-expect-error no types for cose-bilkent
import coseBilkent from "cytoscape-cose-bilkent";
import { useGraphData } from "@/hooks/useGraphData";
import { Badge } from "@/components/ui/badge";
import { Search, X } from "lucide-react";

cytoscape.use(coseBilkent);

const NODE_TYPE_PREFIXES: Record<string, string> = {
  "pages_": "Páginas",
  "components_": "Componentes",
  "schema_": "Esquema BD",
  "table_": "Tablas BD",
  "workflows_": "Workflows N8N",
  "edge_functions_": "Edge Functions",
  "architecture_": "Arquitectura",
  "concept_": "Conceptos",
  "admin_guide_": "Guías Admin",
  "agent_guide_": "Guías Agente",
};

const RELATION_COLORS: Record<string, string> = {
  calls: "#7c3aed",
  references: "#2563eb",
  shares_data_with: "#059669",
  conceptually_related_to: "#d97706",
  depends_on: "#dc2626",
};

function getNodeType(id: string): string {
  for (const prefix of Object.keys(NODE_TYPE_PREFIXES)) {
    if (id.startsWith(prefix)) return prefix;
  }
  return "other_";
}

const NODE_COLORS = [
  "#6366f1","#8b5cf6","#ec4899","#ef4444","#f97316",
  "#eab308","#22c55e","#14b8a6","#06b6d4","#3b82f6",
];

export function GraphViewer() {
  const { data, isLoading, error } = useGraphData();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [search, setSearch] = useState("");
  const [filterCommunity, setFilterCommunity] = useState<string>("all");
  const [filterRelation, setFilterRelation] = useState<string>("all");
  const [selectedNode, setSelectedNode] = useState<{ id: string; label: string; type: string; community: number; sourceFile: string | null; neighbors: string[] } | null>(null);

  const communities = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.nodes.map((n) => n.community))].sort((a, b) => a - b);
  }, [data]);

  const relations = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.edges.map((e) => e.relation))].sort();
  }, [data]);

  useEffect(() => {
    if (!data || !containerRef.current) return;

    const filteredNodes = data.nodes.filter((n) =>
      filterCommunity === "all" || n.community === parseInt(filterCommunity)
    );
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = data.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target) &&
        (filterRelation === "all" || e.relation === filterRelation)
    );

    const typeKeys = [...new Set(filteredNodes.map((n) => getNodeType(n.id)))];
    const typeColorMap = new Map(typeKeys.map((t, i) => [t, NODE_COLORS[i % NODE_COLORS.length]]));

    const elements = [
      ...filteredNodes.map((n) => ({
        data: { id: n.id, label: n.label, type: getNodeType(n.id), community: n.community, sourceFile: n.source_file },
      })),
      ...filteredEdges.map((e, i) => ({
        data: { id: `e${i}`, source: e.source, target: e.target, relation: e.relation, weight: e.weight },
      })),
    ];

    if (cyRef.current) cyRef.current.destroy();

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele: cytoscape.NodeSingular) => typeColorMap.get(ele.data("type")) ?? "#94a3b8",
            "label": "data(label)",
            "font-size": "10px",
            "color": "#1e293b",
            "text-outline-color": "#fff",
            "text-outline-width": 2,
            "width": 28,
            "height": 28,
          },
        },
        {
          selector: "edge",
          style: {
            "width": (ele: cytoscape.EdgeSingular) => Math.max(1, ele.data("weight") * 2),
            "line-color": (ele: cytoscape.EdgeSingular) => RELATION_COLORS[ele.data("relation")] ?? "#94a3b8",
            "opacity": 0.5,
            "curve-style": "bezier",
          },
        },
        {
          selector: "node:selected",
          style: { "border-width": 3, "border-color": "#f97316" },
        },
      ],
      layout: {
        name: elements.length > 300 ? "cose" : "cose-bilkent",
        animate: false,
        randomize: true,
        nodeDimensionsIncludeLabels: false,
      } as Parameters<cytoscape.Core["layout"]>[0],
    });

    cyRef.current.on("tap", "node", (evt) => {
      const node = evt.target;
      const neighbors = node.neighborhood("node").map((n: cytoscape.NodeSingular) => n.data("label") as string);
      setSelectedNode({
        id: node.id() as string,
        label: node.data("label") as string,
        type: NODE_TYPE_PREFIXES[node.data("type")] ?? "Otro",
        community: node.data("community") as number,
        sourceFile: node.data("sourceFile") as string | null,
        neighbors,
      });
    });

    cyRef.current.on("tap", (evt) => {
      if (evt.target === cyRef.current) setSelectedNode(null);
    });

    return () => { cyRef.current?.destroy(); };
  }, [data, filterCommunity, filterRelation]);

  useEffect(() => {
    if (!cyRef.current || !search) return;
    const node = cyRef.current.nodes().filter((n) =>
      (n.data("label") as string).toLowerCase().includes(search.toLowerCase())
    ).first();
    if (node.length) {
      cyRef.current.animate({ center: { eles: node }, zoom: 2 }, { duration: 400 });
      node.select();
    }
  }, [search]);

  if (isLoading) return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      Cargando grafo de conocimiento…
    </div>
  );
  if (error) return (
    <div className="flex items-center justify-center h-full text-destructive">
      Error al cargar graph.json: {(error as Error).message}
    </div>
  );

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            className="w-full pl-8 pr-8 py-2 text-sm border rounded-md bg-background"
            placeholder="Buscar nodo…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="absolute right-2 top-2.5" onClick={() => setSearch("")}>
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
        <select
          className="text-sm border rounded-md px-2 py-2 bg-background"
          value={filterCommunity}
          onChange={(e) => setFilterCommunity(e.target.value)}
        >
          <option value="all">Todas las comunidades</option>
          {communities.map((c) => (
            <option key={c} value={c}>Comunidad {c}</option>
          ))}
        </select>
        <select
          className="text-sm border rounded-md px-2 py-2 bg-background"
          value={filterRelation}
          onChange={(e) => setFilterRelation(e.target.value)}
        >
          <option value="all">Todas las relaciones</option>
          {relations.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <div className="text-xs text-muted-foreground">
          {data?.nodes.length ?? 0} nodos · {data?.edges.length ?? 0} edges
        </div>
      </div>

      {/* Graph + Side Panel */}
      <div className="flex flex-1 overflow-hidden gap-0">
        <div ref={containerRef} className="flex-1 bg-slate-50 dark:bg-slate-900" />
        {selectedNode && (
          <div className="w-72 border-l bg-background p-4 overflow-y-auto">
            <div className="flex items-start justify-between mb-3">
              <h3 className="font-semibold text-sm leading-tight">{selectedNode.label}</h3>
              <button onClick={() => setSelectedNode(null)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Tipo</p>
                <Badge variant="secondary">{selectedNode.type}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Comunidad</p>
                <p className="font-mono">{selectedNode.community}</p>
              </div>
              {selectedNode.sourceFile && (
                <div>
                  <p className="text-xs text-muted-foreground">Archivo</p>
                  <p className="font-mono text-xs break-all">{selectedNode.sourceFile}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Vecinos ({selectedNode.neighbors.length})</p>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.neighbors.slice(0, 20).map((n) => (
                    <Badge key={n} variant="outline" className="text-[10px]">{n}</Badge>
                  ))}
                  {selectedNode.neighbors.length > 20 && (
                    <Badge variant="outline" className="text-[10px]">+{selectedNode.neighbors.length - 20} más</Badge>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
