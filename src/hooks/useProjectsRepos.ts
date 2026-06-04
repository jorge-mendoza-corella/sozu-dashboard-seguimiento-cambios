import { useQuery } from "@tanstack/react-query";
import { getProjects, getRepos } from "@/lib/firestoreProjects";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: getProjects, staleTime: 60 * 1000 });
}

export function useRepos() {
  return useQuery({ queryKey: ["repos"], queryFn: getRepos, staleTime: 60 * 1000 });
}
