import { useQuery } from "@tanstack/react-query";

const GRAPH_URL =
  "https://raw.githubusercontent.com/jorge-mendoza-corella/sozu-docs/main/graphify-out/graph.json";

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
      const token = import.meta.env.VITE_GITHUB_TOKEN;
      const res = await fetch(GRAPH_URL, {
        headers: {
          ...(token ? { Authorization: `token ${token}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`No se pudo cargar graph.json (${res.status})`);
      const raw = await res.json();
      return {
        nodes: (raw.nodes ?? []) as GraphNode[],
        edges: (raw.links ?? raw.edges ?? []) as GraphEdge[],
      };
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
