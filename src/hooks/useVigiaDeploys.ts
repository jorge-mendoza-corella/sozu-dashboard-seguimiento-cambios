/**
 * Vigía de deploys de GeorgIA: escucha las consultas `github-status` que ya hace
 * el dashboard (CI/CD consulta todos los repos aunque solo pinte las tarjetas
 * del proyecto abierto; Resumen también) y revisa cada repo con
 * `revisarDeploys`. Así GeorgIA reacciona a un deploy de cualquier repo,
 * esté o no en pantalla, sin pedirle nada extra a GitHub.
 *
 * Tras un PRD exitoso, además liga el PR hacia main con los tickets que se le
 * pasaron a Claude (trailer Ticket-SOZU) para avisar que ya se pueden cerrar.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EVENTO_TICKETS_LISTOS, revisarDeploys } from "@/lib/festejoDeploy";
import { ticketsResueltosEnDeploy } from "@/lib/agenteTickets";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import { useClients } from "@/hooks/useClients";
import type { RepoStatus } from "@/lib/github";
import type { AppUser } from "@/lib/firestoreUsers";

export function useVigiaDeploys(usuario: AppUser | null, revisarTickets: boolean) {
  const qc = useQueryClient();
  const { data: repos = [] } = useRepos();
  const { data: proyectos = [] } = useProjects();
  const { data: empresas = [] } = useClients(usuario);

  // Lo que el suscriptor necesita leer sin re-suscribirse a cada render.
  const ctx = useRef({ repos, proyectos, empresas, email: usuario?.email ?? null, revisarTickets });
  useEffect(() => {
    ctx.current = { repos, proyectos, empresas, email: usuario?.email ?? null, revisarTickets };
  }, [repos, proyectos, empresas, usuario?.email, revisarTickets]);

  useEffect(() => {
    const revisar = (estados: RepoStatus[]) => {
      const { repos, proyectos, empresas, email, revisarTickets } = ctx.current;
      for (const st of estados) {
        const monitoreado = repos.find((r) => r.owner === st.owner && r.repo === st.repo);
        const proyecto = proyectos.find((p) => p.id === monitoreado?.projectId);
        const empresa = empresas.find((c) => c.id === proyecto?.clientId);
        const reacciones = revisarDeploys(st.owner, st.repo, st.latestRuns, {
          repo: st.label,
          proyecto: proyecto?.name ?? null,
          empresa: empresa ? empresa.tradeName || empresa.legalName : null,
        });
        const prd = reacciones.find((r) => r.rama === "main" && r.resultado === "exito");
        if (prd?.sha && email && revisarTickets) {
          ticketsResueltosEnDeploy(email, st.owner, st.repo, st.label, prd.sha)
            .then((listos) => {
              if (listos.length) window.dispatchEvent(new CustomEvent(EVENTO_TICKETS_LISTOS, { detail: { tickets: listos } }));
            })
            .catch((e) => console.warn("[GeorgIA] no se pudo ligar el deploy con sus tickets", e));
        }
      }
    };
    // Lo que ya está en caché sirve de punto de partida (revisarDeploys no festeja la primera vista).
    // Una consulta por repo (useGitHubStatus): el dato es un solo RepoStatus.
    const comoLista = (d: unknown): RepoStatus[] => (d ? (Array.isArray(d) ? d : [d as RepoStatus]) : []);
    for (const q of qc.getQueryCache().findAll({ queryKey: ["github-status"] })) {
      revisar(comoLista(q.state.data));
    }
    return qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== "updated" || ev.action.type !== "success") return;
      if (ev.query.queryKey[0] !== "github-status") return;
      revisar(comoLista(ev.query.state.data));
    });
  }, [qc]);
}
