import { useQuery } from "@tanstack/react-query";
import { tokenClaude } from "@/lib/agenteTickets";

export const CLAVE_TOKEN_CLAUDE = ["claude-token"];

/** El token de Claude de quien entra. Lo comparten el aviso, el botón de mandar y la conexión. */
export function useTokenClaude() {
  return useQuery({ queryKey: CLAVE_TOKEN_CLAUDE, queryFn: tokenClaude, staleTime: 30 * 60_000, retry: 1 });
}
