import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs, serverTimestamp, query, where,
} from "firebase/firestore";

export const SUPERUSER_EMAIL = "jorge.mendoza@sozu.com";

/**
 * - `superuser`  administrador global del servicio (ve y toca todo).
 * - `client_admin` administrador de una o varias EMPRESAS: manda dentro de sus
 *   clientes (proyectos, usuarios, contribuidores, notificaciones) y no ve al resto.
 * - `developer` trabaja en los repos que se le asignen: solo Resumen y CI/CD.
 * - `viewer` lo mismo que developer; se conserva porque hay cuentas con ese rol
 *   guardado y cambiárselo por debajo sería moverles el acceso sin avisar.
 *
 * El superusuario raíz (`SUPERUSER_EMAIL`) sigue siendo un caso aparte: es el
 * único que puede crear clientes, mover tarifas y tocar datos fiscales.
 */
export type UserRole = "superuser" | "client_admin" | "developer" | "viewer";

export const ROLE_LABEL: Record<UserRole, string> = {
  superuser: "Administrador global",
  client_admin: "Administrador de empresa",
  developer: "Desarrollador",
  viewer: "Viewer",
};

/** Roles que solo operan (Resumen y CI/CD), sin pantallas de administración. */
export const esRolOperativo = (rol: UserRole) => rol === "developer" || rol === "viewer";

/** Permisos granulares de acciones CI/CD por usuario. */
export interface CicdPermissions {
  createPR: boolean; // generar (y cerrar) PRs
  approve: boolean; // aprobar / solicitar cambios / comentar reviews
  mergeDev: boolean; // hacer merge de PRs hacia dev
  mergeMain: boolean; // hacer merge de PRs hacia main (PRD)
  buildApp: boolean; // disparar/cancelar builds de apps en Codemagic
  viewOthers: boolean; // ver ramas y PRs de otros (apagado = solo lo suyo; main/dev siempre visibles)
}

export const NO_PERMISSIONS: CicdPermissions = { createPR: false, approve: false, mergeDev: false, mergeMain: false, buildApp: false, viewOthers: false };
export const ALL_PERMISSIONS: CicdPermissions = { createPR: true, approve: true, mergeDev: true, mergeMain: true, buildApp: true, viewOthers: true };

export interface AppUser {
  email: string;
  role: UserRole;
  addedBy: string;
  createdAt: unknown;
  /**
   * Empresas (clientes) a las que pertenece el usuario. Para un `client_admin`
   * son las empresas que administra; para un viewer, la empresa de la que es
   * empleado. Vacío = legacy, sin empresa asignada.
   */
  clientIds?: string[];
  /**
   * De sus empresas, cuáles puede CONFIGURAR (marca y notificaciones).
   *
   * Vacío = ninguna: las ve en solo lectura. Es explícito a propósito — "no
   * configura nada" es un estado legítimo, y con un vacío que significara
   * "todas" no había forma de expresarlo.
   *
   * Ojo: configurar no es administrar. Sus empresas (`clientIds`) siguen siendo
   * las que administra en usuarios, proyectos y repos; esto acota solo la
   * pantalla de Configuración.
   */
  configClientIds?: string[];
  /** @deprecated Nombre anterior de `configClientIds`; se sigue leyendo. */
  adminClientIds?: string[];
  projectIds?: string[]; // proyectos a los que tiene acceso (vacío/undefined = legacy: todos)
  /**
   * Repos a los que tiene acceso, dentro de esos proyectos. Vacío/undefined =
   * todos los del proyecto. Es el nivel más fino: un desarrollador puede estar
   * en un proyecto y tocar solo un repo de los seis.
   */
  repoIds?: string[];
  permissions?: CicdPermissions; // undefined = legacy: admins todo, viewers nada
  githubToken?: string; // PAT personal de GitHub (obligatorio para operar; root exento)
  githubLogin?: string; // login de GitHub derivado del token (GET /user)
  githubTokenUpdatedAt?: unknown;
  /**
   * Avisos de WhatsApp de TODOS los repos, no solo de los suyos.
   *
   * Es una suscripción del dueño del servicio: el admin global no es autor ni
   * aprobador de casi nada, así que por el camino normal no le llega nada de la
   * cartera. Con esto prendido recibe cada PR y cada deploy de cualquier
   * empresa.
   *
   * Sale por la instancia de la EMPRESA dueña del repo, no por una global: no
   * hay ninguna, y eso mantiene la regla —si esa empresa tiene los avisos
   * apagados, tampoco se manda esta copia—. Su teléfono sigue saliendo de
   * Contribuidores, igual que el de todos.
   *
   * Apagado por defecto: son todos los movimientos de todos los repos, y eso
   * suscrito sin pedirlo es una avalancha.
   */
  avisaDeTodosLosRepos?: boolean;
}

/**
 * Permisos efectivos: el root siempre tiene todo; usuarios sin campo `permissions`
 * conservan el comportamiento previo (Administrador = todo, Viewer = nada).
 */
export function resolvePermissions(user: AppUser | null): CicdPermissions {
  if (!user) return NO_PERMISSIONS;
  // Por ROL, no por correo: mientras el root ve el dashboard como otra persona
  // conserva su correo, y compararlo le devolvía todos los permisos —con eso la
  // simulación mostraba botones que esa persona no tiene—.
  if (isRootAdmin(user)) return ALL_PERMISSIONS;
  if (user.permissions) return { ...NO_PERMISSIONS, ...user.permissions };
  // Sin permisos explícitos: los administradores (globales o de empresa) los
  // tienen todos dentro de lo que ven; quien solo opera, ninguno.
  return esRolOperativo(user.role) ? NO_PERMISSIONS : ALL_PERMISSIONS;
}

/**
 * ¿Es el superusuario raíz operando como él mismo?
 *
 * Mira el rol además del correo, y esa es la parte que importa: cuando el root
 * usa "ver como" una empresa, su perfil en memoria pasa a `client_admin` sin
 * cambiar de correo. Comparar solo el correo dejaría toda la interfaz de root
 * encendida durante la impersonación, y la simulación no serviría de nada.
 */
export const isRootAdmin = (user: AppUser | null) =>
  !!user && user.email === SUPERUSER_EMAIL && user.role === "superuser";

/** ¿Administra la empresa indicada? (el root administra todas) */
export function isAdminOfClient(user: AppUser | null, clientId: string | undefined): boolean {
  if (!user || !clientId) return false;
  if (user.role === "superuser") return true;
  return user.role === "client_admin" && (user.clientIds ?? []).includes(clientId);
}

/**
 * Empresas cuya CONFIGURACIÓN puede editar (subconjunto de las suyas).
 *
 * Vacío significa ninguna, no todas: poder no configurar nada es un estado
 * legítimo, y hacerlo significar "todas" lo volvía inexpresable.
 */
export function editableClientIds(user: AppUser | null): string[] {
  if (!user || user.role !== "client_admin") return [];
  const suyas = user.clientIds ?? [];
  const configurables = user.configClientIds ?? user.adminClientIds ?? [];
  return suyas.filter((id) => configurables.includes(id));
}

/** Guarda qué empresas puede configurar, de entre las que ya tiene asignadas. */
export async function setUserConfigClients(email: string, configClientIds: string[]) {
  await setDoc(doc(db, "users", email), { configClientIds }, { merge: true });
}

/** Empresas que administra. El root/superuser devuelve null = todas. */
export function adminClientIds(user: AppUser | null): string[] | null {
  if (!user) return [];
  // Mismo criterio: el rol manda. Con el correo, el root impersonando seguía
  // saliendo como admin global y veía TODOS los proyectos de TODAS las empresas.
  if (user.role === "superuser") return null;
  return user.role === "client_admin" ? user.clientIds ?? [] : [];
}

/**
 * Clave de caché del ALCANCE de un usuario, para los `queryKey` de react-query.
 *
 * No basta con el correo: al ver el dashboard como otra persona, el correo sigue
 * siendo el del root y solo cambian el rol y las empresas. Con el correo como
 * clave, la lista que ve el root y la que vería esa persona compartían entrada
 * de caché — y el root terminaba viendo su propia lista completa desde dentro de
 * la impersonación.
 */
export const scopeKeyOf = (user: AppUser | null) =>
  user ? `${user.email}|${user.role}|${(user.clientIds ?? []).join(",")}` : "anon";

/** Puede entrar a las pantallas de administración (Usuarios, Configuración). */
export const canAdminister = (user: AppUser | null) =>
  !!user && (user.role === "superuser" || user.role === "client_admin");

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const snap = await getDoc(doc(db, "users", email));
  return snap.exists() ? (snap.data() as AppUser) : null;
}

export async function getAllUsers(): Promise<AppUser[]> {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => d.data() as AppUser);
}

/**
 * Usuarios de las empresas indicadas. Es la lectura que hace un administrador
 * de empresa: las reglas no le dejan barrer toda la colección, y la consulta
 * tiene que venir filtrada para que se la autoricen.
 */
export async function getUsersByClients(clientIds: string[]): Promise<AppUser[]> {
  if (clientIds.length === 0) return [];
  // Una consulta POR empresa, no un `array-contains-any` con todas.
  //
  // Las reglas exigen que la consulta se pueda demostrar por sí sola, y una
  // condición con varios valores es justo la que el motor no siempre puede
  // casar: la consulta entera se deniega y la lista sale vacía sin explicación.
  // Además, así una empresa que falle no se lleva a las demás.
  const porEmpresa = await Promise.all(
    clientIds.map(async (id) => {
      try {
        const q = query(collection(db, "users"), where("clientIds", "array-contains", id));
        return (await getDocs(q)).docs.map((d) => d.data() as AppUser);
      } catch {
        return [] as AppUser[];
      }
    }),
  );
  // Un usuario puede pertenecer a varias de sus empresas: se deduplica.
  const porEmail = new Map<string, AppUser>();
  for (const u of porEmpresa.flat()) porEmail.set(u.email, u);
  return [...porEmail.values()];
}

/**
 * Los usuarios que este usuario puede ver: todos si es admin global, los de sus
 * empresas si es administrador de empresa, y nadie más en cualquier otro caso.
 */
export async function getVisibleUsers(user: AppUser | null): Promise<AppUser[]> {
  const empresas = adminClientIds(user);
  if (empresas === null) return getAllUsers();
  const deSusEmpresas = await getUsersByClients(empresas);
  // El propio usuario entra si de verdad pertenece a alguna de esas empresas.
  // La comprobación importa por la impersonación: el root conserva su correo
  // mientras ve como otro, y sin esto se colaba a sí mismo en una lista donde
  // esa persona no lo vería jamás.
  const pertenece = (user?.clientIds ?? []).some((id) => empresas.includes(id));
  if (user && pertenece && !deSusEmpresas.some((u) => u.email === user.email)) {
    return [user, ...deSusEmpresas];
  }
  return deSusEmpresas;
}

export async function addUser(
  email: string,
  addedBy: string,
  role: UserRole = "viewer",
  projectIds: string[] = [],
  permissions: CicdPermissions = NO_PERMISSIONS,
  githubToken?: string,
  githubLogin?: string,
  clientIds: string[] = [],
  repoIds: string[] = [],
) {
  if (role === "client_admin" && clientIds.length === 0) {
    throw new Error("Un administrador de empresa necesita al menos una empresa asignada.");
  }
  await setDoc(doc(db, "users", email), {
    email,
    role,
    addedBy,
    clientIds,
    projectIds,
    repoIds,
    permissions,
    ...(githubToken && githubLogin
      ? { githubToken, githubLogin, githubTokenUpdatedAt: serverTimestamp() }
      : {}),
    createdAt: serverTimestamp(),
  });
}

/**
 * Guarda el PAT de GitHub del usuario (y su login derivado). Lo puede hacer
 * el propio usuario (gate de entrada) o el root desde Gestión de Accesos.
 */
export async function setUserGithubToken(email: string, token: string, login: string) {
  // Dos personas del dashboard no pueden compartir cuenta de GitHub: cada PR,
  // aprobación y merge sale a nombre del login del token, así que el historial
  // acabaría diciendo que alguien hizo lo que hizo otro. Además atrapa el
  // accidente real que motivó esta guarda: pegar aquí el token que uno tenía a
  // la mano —el de otro— y quedarse actuando como esa persona sin notarlo,
  // hasta que GitHub contesta 404 porque esa cuenta no tiene escritura.
  // Best-effort: quien registra su propia key desde el gate no siempre puede
  // listar usuarios, y quedarse sin registrar token por no poder comprobar
  // sería peor que la colisión que se está evitando.
  let duenoPrevio: AppUser | undefined;
  try {
    duenoPrevio = (await getAllUsers()).find(
      (u) => u.githubLogin === login && u.email !== email,
    );
  } catch {
    duenoPrevio = undefined;
  }
  if (duenoPrevio) {
    throw new Error(
      `Esa API key es de la cuenta de GitHub @${login}, que ya está registrada para ${duenoPrevio.email}. ` +
      "Usa una API key de tu propia cuenta.",
    );
  }
  await setDoc(
    doc(db, "users", email),
    { githubToken: token, githubLogin: login, githubTokenUpdatedAt: serverTimestamp() },
    { merge: true },
  );
}

/**
 * Prende o apaga los avisos de todos los repos para un usuario.
 *
 * Solo tiene efecto para un admin global —a nadie más se le mandan repos que no
 * son suyos—, y lo escribe cada quien sobre su propio documento: las reglas no
 * dejan a nadie tocar el doc del superusuario raíz, ni siquiera a él, salvo en
 * los campos que son suyos por definición.
 */
export async function setUserAvisaDeTodos(email: string, valor: boolean) {
  await setDoc(doc(db, "users", email), { avisaDeTodosLosRepos: valor }, { merge: true });
}

/** Actualiza los permisos CI/CD de un usuario. */
export async function setUserPermissions(email: string, permissions: CicdPermissions) {
  if (email === SUPERUSER_EMAIL) throw new Error("El superusuario raíz siempre tiene todos los permisos");
  await setDoc(doc(db, "users", email), { permissions }, { merge: true });
}

export async function removeUser(email: string) {
  if (email === SUPERUSER_EMAIL) throw new Error("El superusuario raíz no puede eliminarse");
  await deleteDoc(doc(db, "users", email));
}

/**
 * Cambia el rol de un usuario existente. Un administrador de empresa sin
 * empresas no administra nada, así que el rol y las empresas se guardan juntos
 * cuando hace falta.
 */
export async function setUserRole(email: string, role: UserRole, clientIds?: string[]) {
  if (email === SUPERUSER_EMAIL) throw new Error("No se puede cambiar el rol del superusuario raíz");
  // Un administrador de empresa sin empresas no administra nada, pero rechazar
  // el cambio de rol dejaba un callejón sin salida: para asignarle empresas hay
  // que verlo primero como administrador. Se permite el paso intermedio y la
  // pantalla lo marca como pendiente hasta que tenga al menos una. Al DAR DE
  // ALTA sí se exige, porque ahí ambas cosas se capturan de una vez.
  await setDoc(
    doc(db, "users", email),
    { role, ...(clientIds ? { clientIds } : {}) },
    { merge: true },
  );
}

/**
 * Repos a los que tiene acceso. Lista vacía = todos los de sus proyectos, que
 * es el comportamiento de siempre y el que conserva a quien nunca lo configuró.
 */
export async function setUserRepos(email: string, repoIds: string[]) {
  await setDoc(doc(db, "users", email), { repoIds }, { merge: true });
}

/** Empresas a las que pertenece (o que administra) el usuario. */
export async function setUserClients(email: string, clientIds: string[]) {
  await setDoc(doc(db, "users", email), { clientIds }, { merge: true });
}

/**
 * Proyectos a los que tiene acceso. Lista vacía = todos los de sus empresas,
 * igual que los demás niveles del alcance.
 *
 * Antes exigía al menos uno, y eso creaba un callejón sin salida real: a un
 * usuario con una sola empresa y un solo proyecto de esa empresa no se le podía
 * quitar la empresa (se quedaría sin proyectos) ni el proyecto (mínimo uno). Ni
 * el root podía deshacerlo.
 */
export async function setUserProjects(email: string, projectIds: string[]) {
  await setDoc(doc(db, "users", email), { projectIds }, { merge: true });
}

export async function seedSuperuser() {
  const existing = await getUserByEmail(SUPERUSER_EMAIL);
  if (!existing) {
    await setDoc(doc(db, "users", SUPERUSER_EMAIL), {
      email: SUPERUSER_EMAIL,
      role: "superuser",
      addedBy: "system",
      createdAt: serverTimestamp(),
    });
  }
}
