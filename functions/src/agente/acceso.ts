/**
 * Quién puede usar el agente y sobre qué repos.
 *
 * El permiso NO vive en `users/{email}`: ese documento lo puede editar un
 * administrador de empresa (sus reglas de update no acotan campos), y se
 * habría podido prender el agente a sí mismo o a sus viewers. Vive en
 * `agente_config/acceso`, que solo escribe el root (ver firestore.rules).
 *
 *   agente_config/acceso = { emails: string[], docs?: string[], tickets?: string[], limitePorHora?: number }
 *
 * `emails` usa el agente; `docs` además puede abrir los documentos de sozu-docs
 * que el agente cita (función `agenteDoc`). Son permisos independientes. El
 * root (`SUPERUSER_EMAIL`) tiene los dos siempre, aunque el doc no exista.
 * `tickets` revisa cada 15 min los tickets del portal de sozu-admin asignados a
 * la persona (función `agenteTickets`). El root lo tiene prendido por default,
 * como todo lo demás; si lo apaga, queda en `ticketsApagados`.
 */
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import type { RepoAgente } from "./codigo.js";

export const SUPERUSER_EMAIL = "jorge.mendoza@sozu.com";
const LIMITE_HORA_DEFAULT = 40;

export interface Usuario {
  email: string;
  esRoot: boolean;
  limitePorHora: number;
  /** Puede abrir los documentos citados (lista `docs`). */
  verDocs: boolean;
  /** Revisa sus tickets del portal (lista `tickets`, requiere agente). */
  verTickets: boolean;
}

export type Permiso = "agente" | "docs" | "tickets";

/**
 * Mismo criterio que `esRootVerificado()` de las reglas: email verificado y
 * login de Google. Sin esto, si algún día se prende otro proveedor, alguien
 * podría registrarse con un email de la lista sin verificarlo.
 */
export async function verificarAcceso(req: CallableRequest, permiso: Permiso = "agente"): Promise<Usuario> {
  const t = req.auth?.token;
  if (!t?.email) throw new HttpsError("unauthenticated", "Inicia sesión para usar el agente.");
  if (t.email_verified !== true || t.firebase?.sign_in_provider !== "google.com") {
    throw new HttpsError("permission-denied", "El agente requiere sesión de Google con correo verificado.");
  }
  const email = t.email.toLowerCase();
  const snap = await getFirestore().doc("agente_config/acceso").get();
  const cfg = snap.data() ?? {};
  const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map((e) => String(e).toLowerCase()) : []);
  const esRoot = email === SUPERUSER_EMAIL;
  const usaAgente = esRoot || lista(cfg.emails).includes(email);
  const verDocs = esRoot || lista(cfg.docs).includes(email);
  const verTickets = esRoot
    ? !lista(cfg.ticketsApagados).includes(email)
    : usaAgente && lista(cfg.tickets).includes(email);
  if (permiso === "agente" && !usaAgente) {
    throw new HttpsError("permission-denied", "No tienes acceso al agente de repos.");
  }
  if (permiso === "docs" && !verDocs) {
    throw new HttpsError("permission-denied", "No tienes permiso para ver la documentación.");
  }
  if (permiso === "tickets" && !verTickets) {
    throw new HttpsError("permission-denied", "No tienes activada la revisión de tickets.");
  }
  const limite = Number(cfg.limitePorHora);
  return { email, esRoot, verDocs, verTickets, limitePorHora: Number.isFinite(limite) && limite > 0 ? limite : LIMITE_HORA_DEFAULT };
}

/**
 * Ventana fija por hora en `agente_uso/{email}`. El root también tiene tope:
 * protege la API key de un bucle o de una pestaña olvidada reintentando.
 */
export async function consumirCupo(u: Usuario): Promise<number> {
  const ref = getFirestore().doc(`agente_uso/${u.email}`);
  const hora = new Date().toISOString().slice(0, 13);
  return getFirestore().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const usadas = d?.hora === hora ? Number(d.preguntas ?? 0) : 0;
    if (usadas >= u.limitePorHora) {
      throw new HttpsError("resource-exhausted", `Llegaste al límite de ${u.limitePorHora} preguntas por hora.`);
    }
    tx.set(ref, { hora, preguntas: usadas + 1, ultima: FieldValue.serverTimestamp() }, { merge: true });
    return u.limitePorHora - usadas - 1;
  });
}

/**
 * Repos que el usuario ve en el dashboard: el root todos; el resto, los de sus
 * `projectIds` (y dentro de ellos sus `repoIds`, si los tiene), igual que el
 * recorte de la pantalla de CI/CD.
 */
export async function reposPermitidos(u: Usuario): Promise<RepoAgente[]> {
  const db = getFirestore();
  const [repos, proyectos] = await Promise.all([db.collection("repos").get(), db.collection("projects").get()]);
  const nombreProyecto = new Map(proyectos.docs.map((p) => [p.id, String(p.data().name ?? p.id)]));
  let docs = repos.docs;
  if (!u.esRoot) {
    const perfil = (await db.doc(`users/${u.email}`).get()).data() ?? {};
    const proyectosUsuario: string[] = Array.isArray(perfil.projectIds) ? perfil.projectIds : [];
    const reposUsuario: string[] = Array.isArray(perfil.repoIds) ? perfil.repoIds : [];
    docs = docs.filter((r) => {
      if (proyectosUsuario.length && !proyectosUsuario.includes(r.data().projectId)) return false;
      if (reposUsuario.length && !reposUsuario.includes(r.id)) return false;
      return true;
    });
  }
  return docs
    .map((r) => {
      const d = r.data();
      return {
        owner: String(d.owner),
        repo: String(d.repo),
        label: String(d.label ?? d.repo),
        proyecto: nombreProyecto.get(d.projectId) ?? "sin proyecto",
      };
    })
    .sort((a, b) => a.proyecto.localeCompare(b.proyecto) || a.label.localeCompare(b.label));
}
