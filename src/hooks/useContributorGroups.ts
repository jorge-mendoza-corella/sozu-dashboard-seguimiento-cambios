import { useQuery } from "@tanstack/react-query";
import { getGroups } from "@/lib/firestoreGroups";
import { getHiddenContributors } from "@/lib/firestoreContributors";

export function useContributorGroups() {
  return useQuery({ queryKey: ["contributor-groups"], queryFn: getGroups, staleTime: 60 * 1000 });
}

export function useHiddenContributors() {
  return useQuery({
    queryKey: ["hidden-contributors"],
    queryFn: getHiddenContributors,
    staleTime: 60 * 1000,
  });
}
