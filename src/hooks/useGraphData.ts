import { useQuery } from "@tanstack/react-query";

const REPO = "jorge-mendoza-corella/sozu-docs";
const BRANCH = "main";
const GRAPH_PATH = "graphify-out/graph.json";

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
      const token = import.meta.env.VITE_GITHUB_DOCS_TOKEN;
      const baseHeaders: Record<string, string> = {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `token ${token}` } : {}),
      };

      // Step 1: Get blob SHA via recursive tree — avoids the 1 MB Contents API limit
      const treeRes = await fetch(
        `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
        { headers: baseHeaders }
      );
      if (!treeRes.ok)
        throw new Error(`Error al obtener árbol del repositorio (${treeRes.status})`);
      const { tree } = (await treeRes.json()) as {
        tree: { path: string; type: string; sha: string }[];
      };
      const entry = tree.find((e) => e.path === GRAPH_PATH && e.type === "blob");
      if (!entry) throw new Error("graph.json no encontrado en el repositorio");

      // Step 2: Fetch raw blob — Git Data API supports files up to 100 MB
      const blobRes = await fetch(
        `https://api.github.com/repos/${REPO}/git/blobs/${entry.sha}`,
        { headers: { ...baseHeaders, Accept: "application/vnd.github.raw+json" } }
      );
      if (!blobRes.ok)
        throw new Error(`Error al cargar graph.json (${blobRes.status})`);
      const raw = await blobRes.json();

      return {
        nodes: (raw.nodes ?? []) as GraphNode[],
        edges: (raw.links ?? raw.edges ?? []) as GraphEdge[],
      };
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
