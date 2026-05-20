import { useQuery } from "@tanstack/react-query";

const GRAPH_URL =
  "https://raw.githubusercontent.com/jorgeIMendoza/sozu-docs/main/graphify-out/graph.json";

export interface GraphNode {
  id: string;
  label: string;
  file_type: string;
  source_file: string | null;
  community: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  confidence_score: number;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function useGraphData() {
  return useQuery<GraphData>({
    queryKey: ["graph-data"],
    queryFn: async () => {
      const res = await fetch(GRAPH_URL);
      if (!res.ok) throw new Error("No se pudo cargar graph.json");
      const raw = await res.json();
      return {
        nodes: (raw.nodes ?? []) as GraphNode[],
        edges: (raw.edges ?? []) as GraphEdge[],
      };
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
