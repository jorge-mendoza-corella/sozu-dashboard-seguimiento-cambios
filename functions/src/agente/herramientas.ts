/**
 * Catálogo cerrado de herramientas del agente. Todas son de solo lectura; el
 * modelo solo elige herramienta y argumentos, que se validan aquí con zod
 * antes de ejecutar (con `eager_input_streaming` la API ya no los valida).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { buscarEnDocs, leerDoc, obtenerCorpus } from "./docs.js";
import { actividadRepo, buscarCodigo, leerArchivo, resolverRepo, type RepoAgente } from "./codigo.js";

type Tool = Anthropic.Beta.BetaTool;

export const HERRAMIENTAS: Tool[] = [
  {
    name: "buscar_docs",
    description:
      "Busca en la documentación de sozu-docs (técnica por repo y manual de usuario). Devuelve secciones con ruta, encabezado, línea y extracto, ordenadas por relevancia. Úsala primero para casi cualquier pregunta. Usa términos concretos (nombres de pantallas, tablas, funciones), no frases largas.",
    input_schema: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "Términos a buscar, p. ej. 'clabe stp conciliacion'." },
        seccion: { type: "string", description: "Opcional: carpeta a la que acotar, p. ej. 'user-manual' o 'edge-functions'." },
      },
      required: ["consulta"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "leer_doc",
    description:
      "Lee un archivo de la documentación por su ruta (relativa a docs/, tal como aparece en el índice o en buscar_docs). Devuelve hasta ~40k caracteres; si el archivo sigue, pide la siguiente parte con desde_linea.",
    input_schema: {
      type: "object",
      properties: {
        ruta: { type: "string" },
        desde_linea: { type: "integer", minimum: 1 },
      },
      required: ["ruta"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "buscar_codigo",
    description:
      "Busca en el código de los repos con la búsqueda de código de GitHub (rama por defecto). Devuelve archivos y fragmentos. Acepta la sintaxis de GitHub (p. ej. 'ia_conversaciones language:sql' o 'path:supabase/functions guia'). Si no das repo, busca en todos los tuyos.",
    input_schema: {
      type: "object",
      properties: {
        consulta: { type: "string" },
        repo: { type: "string", description: "Opcional: etiqueta del repo (de la lista de repos)." },
      },
      required: ["consulta"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "leer_archivo",
    description:
      "Lee un archivo de un repo (con números de línea) o lista un directorio si la ruta es una carpeta (ruta vacía = raíz). Por defecto en la rama por defecto; usa ref para otra rama, tag o commit.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Etiqueta del repo." },
        ruta: { type: "string" },
        ref: { type: "string" },
        desde_linea: { type: "integer", minimum: 1 },
      },
      required: ["repo", "ruta"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "actividad_repo",
    description:
      "Últimos 20 commits (opcionalmente de una ruta o rama) o últimos 20 PRs de un repo. Para preguntas de qué cambió, cuándo y quién.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        tipo: { type: "string", enum: ["commits", "prs"] },
        ruta: { type: "string" },
        rama: { type: "string" },
      },
      required: ["repo", "tipo"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

const esquemas = {
  buscar_docs: z.object({ consulta: z.string().min(1).max(300), seccion: z.string().max(100).optional() }),
  leer_doc: z.object({ ruta: z.string().min(1).max(300), desde_linea: z.number().int().min(1).optional() }),
  buscar_codigo: z.object({ consulta: z.string().min(1).max(200), repo: z.string().max(200).optional() }),
  leer_archivo: z.object({
    repo: z.string().min(1).max(200),
    ruta: z.string().max(500),
    ref: z.string().max(200).optional(),
    desde_linea: z.number().int().min(1).optional(),
  }),
  actividad_repo: z.object({
    repo: z.string().min(1).max(200),
    tipo: z.enum(["commits", "prs"]),
    ruta: z.string().max(500).optional(),
    rama: z.string().max(200).optional(),
  }),
} as const;

export type NombreHerramienta = keyof typeof esquemas;

export interface Contexto {
  ghDocs: Octokit;
  ghCodigo: Octokit;
  repos: RepoAgente[];
}

/** Etiqueta corta para el panel ("Buscando en docs: clabe stp"). */
export function describirLlamada(nombre: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (nombre) {
    case "buscar_docs": return `Buscando en docs: ${s(i.consulta)}`;
    case "leer_doc": return `Leyendo doc ${s(i.ruta)}`;
    case "buscar_codigo": return `Buscando en código${i.repo ? ` de ${s(i.repo)}` : ""}: ${s(i.consulta)}`;
    case "leer_archivo": return `Leyendo ${s(i.repo)}:${s(i.ruta) || "/"}`;
    case "actividad_repo": return `Revisando ${i.tipo === "prs" ? "PRs" : "commits"} de ${s(i.repo)}`;
    default: return nombre;
  }
}

const error = (codigo: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error: codigo, ...extra });

export async function ejecutar(nombre: string, input: unknown, ctx: Contexto): Promise<{ texto: string; esError: boolean }> {
  if (!(nombre in esquemas)) return { texto: error("herramienta_desconocida"), esError: true };
  const parsed = esquemas[nombre as NombreHerramienta].safeParse(input);
  if (!parsed.success) return { texto: error("INVALID_JSON", { detalle: parsed.error.message.slice(0, 300) }), esError: true };
  const a = parsed.data as Record<string, unknown>;

  const repoDe = (etiqueta: unknown) => resolverRepo(ctx.repos, String(etiqueta));
  const sinRepo = (etiqueta: unknown) => ({
    texto: error("repo_no_permitido", { repo: etiqueta, disponibles: ctx.repos.map((r) => r.label) }),
    esError: true,
  });

  try {
    switch (nombre as NombreHerramienta) {
      case "buscar_docs": {
        const c = await obtenerCorpus(ctx.ghDocs);
        const r = buscarEnDocs(c, String(a.consulta), { seccion: a.seccion as string | undefined });
        return { texto: JSON.stringify({ resultados: r }), esError: false };
      }
      case "leer_doc": {
        const c = await obtenerCorpus(ctx.ghDocs);
        return { texto: leerDoc(c, String(a.ruta), (a.desde_linea as number) ?? 1), esError: false };
      }
      case "buscar_codigo": {
        let repos = ctx.repos;
        if (a.repo) {
          const r = repoDe(a.repo);
          if (!r) return sinRepo(a.repo);
          repos = [r];
        }
        return { texto: await buscarCodigo(ctx.ghCodigo, repos, String(a.consulta)), esError: false };
      }
      case "leer_archivo": {
        const r = repoDe(a.repo);
        if (!r) return sinRepo(a.repo);
        return {
          texto: await leerArchivo(ctx.ghCodigo, r, String(a.ruta), a.ref as string | undefined, (a.desde_linea as number) ?? 1),
          esError: false,
        };
      }
      case "actividad_repo": {
        const r = repoDe(a.repo);
        if (!r) return sinRepo(a.repo);
        return {
          texto: await actividadRepo(ctx.ghCodigo, r, a.tipo as "commits" | "prs", {
            ruta: a.ruta as string | undefined,
            rama: a.rama as string | undefined,
          }),
          esError: false,
        };
      }
    }
  } catch (e) {
    console.error(`[agenteRepos] ${nombre}`, e);
    const status = (e as { status?: number }).status;
    return { texto: error("no_disponible", status ? { status } : {}), esError: true };
  }
}
