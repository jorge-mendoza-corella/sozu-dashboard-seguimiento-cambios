/**
 * "Mandar a Claude": abre en el repo orquestador un issue con el .md del ticket.
 *
 * El workflow de ese repo corre Claude Code con la suscripción (no la API de
 * pago), que clona los repos que hagan falta y abre un PR hacia `dev` en cada
 * uno; los enlaces quedan comentados en el issue. El dashboard nunca ve el token
 * de Claude: vive como secreto en el repo orquestador, uno por persona, y el
 * issue lleva el nombre del de quien lo manda (`<!-- georgia-token:… -->`).
 *
 * Un issue por ticket y persona: si ya se mandó, se devuelve el mismo issue
 * (para pedir ajustes se comenta ahí con @claude).
 */
import type { Octokit } from "@octokit/rest";
import { getFirestore } from "firebase-admin/firestore";
import type { RepoAgente } from "./codigo.js";
import type { TicketSalida } from "./tickets.js";

export const ORQUESTADOR = { owner: "jorgeIMendoza", repo: "sozu-georgia-tareas" } as const;
const ETIQUETA = "georgia";
/** El cuerpo de un issue admite 65,536 caracteres; se deja margen para el pie. */
const MAX_MD = 55_000;

export interface IssueClaude {
  numero: number;
  url: string;
  yaExistia: boolean;
}

function cuerpoIssue(md: string, repos: RepoAgente[], email: string, secreto: string): string {
  const lista = repos.map((r) => `- \`${r.owner}/${r.repo}\` — ${r.label} (${r.proyecto})`).join("\n");
  return `${md.trim().slice(0, MAX_MD)}

## Repos permitidos

Solo estos (son los que ${email} tiene asignados en el dashboard):

${lista || "- (ninguno)"}

---
Mandado desde el dashboard por ${email}. Instrucciones del flujo: \`CLAUDE.md\` de este repo.

@claude trabaja este ticket.
<!-- georgia-token:${secreto} -->
`;
}

export async function mandarAClaude(
  gh: Octokit,
  email: string,
  t: TicketSalida,
  md: string,
  repos: RepoAgente[],
  /** Secret del orquestador con el token de Claude de quien lo manda (ver tokenClaude.ts). */
  secreto: string,
): Promise<IssueClaude> {
  const ref = getFirestore().doc(`agente_tickets_enviados/${email}__${t.id}`);
  const previo = (await ref.get()).data();
  if (previo?.issue?.url) return { numero: previo.issue.numero, url: previo.issue.url, yaExistia: true };

  const { data } = await gh.issues.create({
    ...ORQUESTADOR,
    title: `${t.folio}: ${t.titulo}`.slice(0, 250),
    body: cuerpoIssue(md, repos, email, secreto),
    labels: [ETIQUETA],
  });
  await ref.set(
    {
      owner: email,
      ticketId: t.id,
      numero: t.numero,
      folio: t.folio,
      titulo: t.titulo,
      cerrado: previo?.cerrado ?? false,
      enviadoEn: previo?.enviadoEn ?? new Date().toISOString(),
      issue: { numero: data.number, url: data.html_url, creadoEn: new Date().toISOString() },
    },
    { merge: true },
  );
  return { numero: data.number, url: data.html_url, yaExistia: false };
}
