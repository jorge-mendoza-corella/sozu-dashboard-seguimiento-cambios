import { addClient, getClients, setClientFeatures, type Client } from "./firestoreClients";
import { seedClientWhatsappDefaults } from "./notificationSettings";
import { addProject, getProjects, renameProject, setProjectClient, setProjectIsApp } from "./firestoreProjects";

// ---------------------------------------------------------------------------
// Siembra la estructura SaaS inicial: los cuatro clientes con los que arranca
// la operación y los proyectos de SOZU. Idempotente: reusa lo que ya exista y
// solo crea lo que falta, así que se puede correr varias veces sin duplicar.
//
// El proyecto histórico "SOZU" pasa a llamarse "Admin" (es el dashboard de
// administración) y queda bajo el cliente Sozu, junto con Landings y las dos
// apps. Los repos ya dados de alta se quedan donde están.
// ---------------------------------------------------------------------------

const CLIENTES_INICIALES = ["Vectis", "Sozu", "Monocolo", "Mutuo"] as const;

/** Proyectos del cliente Sozu. `isApp` marca los que se publican en tiendas. */
const PROYECTOS_SOZU: Array<{ name: string; isApp: boolean; alias?: string[] }> = [
  { name: "Admin", isApp: false, alias: ["SOZU", "Sozu", "sozu"] },
  { name: "Landings", isApp: false, alias: ["landings", "Landing"] },
  { name: "Sozu Clientes APP", isApp: true, alias: ["sozu clientes APP", "Clientes APP"] },
  { name: "Sozu Agentes APP", isApp: true, alias: ["sozu agentes APp", "Agentes APP"] },
];

export interface SeedReport {
  clientesCreados: string[];
  proyectosCreados: string[];
  proyectosRenombrados: string[];
  proyectosAsignados: string[];
  /** Se llenó la config de WhatsApp DE SOZU con los valores que traía el CI. */
  notificacionesSembradas: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

export async function seedSaasStructure(email: string): Promise<SeedReport> {
  const report: SeedReport = {
    clientesCreados: [],
    proyectosCreados: [],
    proyectosRenombrados: [],
    proyectosAsignados: [],
    notificacionesSembradas: false,
  };

  // --- Clientes -------------------------------------------------------------
  let clientes = await getClients();
  const buscarCliente = (nombre: string): Client | undefined =>
    clientes.find((c) => norm(c.legalName) === norm(nombre) || norm(c.tradeName ?? "") === norm(nombre));

  for (const nombre of CLIENTES_INICIALES) {
    if (buscarCliente(nombre)) continue;
    const id = await addClient({ legalName: nombre, personaType: "moral", status: "activo" }, email);
    // Esto es una migración, no una venta nueva: los cuatro clientes nacen con
    // las dos features prendidas para que asignarles un proyecto no le apague
    // el deploy ni los avances a nadie que hoy los tenga. Apagarlas es una
    // decisión comercial que se toma después, cliente por cliente.
    await setClientFeatures(id, { publishApps: true, showAvances: true });
    report.clientesCreados.push(nombre);
  }
  clientes = await getClients();

  const sozu = buscarCliente("Sozu");
  if (!sozu) return report; // no debería pasar; sin cliente Sozu no hay a qué asignar

  // Sozu es la casa: opera sus propias apps y su sitio de avances. Si el cliente
  // ya existía de antes (siembra parcial), se le prenden igual.
  if (!sozu.features?.publishApps || !sozu.features?.showAvances) {
    await setClientFeatures(sozu.id, { publishApps: true, showAvances: true });
  }

  // Las notificaciones de WhatsApp dejaron de estar cableadas en el YAML. La
  // instancia y el teléfono que traían son de Sozu, así que se siembran en SU
  // configuración —no en el default global, donde se los heredaría cualquier
  // empresa sin configurar—. La apikey se captura a mano: es un secreto.
  report.notificacionesSembradas = await seedClientWhatsappDefaults(sozu.id, email);

  // --- Proyectos de Sozu ----------------------------------------------------
  const proyectos = await getProjects();
  for (const def of PROYECTOS_SOZU) {
    const nombres = [def.name, ...(def.alias ?? [])].map(norm);
    const existente = proyectos.find((p) => nombres.includes(norm(p.name)));

    if (!existente) {
      const id = await addProject(def.name, email);
      await setProjectClient(id, sozu.id);
      if (def.isApp) await setProjectIsApp(id, true);
      report.proyectosCreados.push(def.name);
      continue;
    }

    if (existente.name !== def.name) {
      await renameProject(existente.id, def.name);
      report.proyectosRenombrados.push(`${existente.name} → ${def.name}`);
    }
    if (existente.clientId !== sozu.id) {
      await setProjectClient(existente.id, sozu.id);
      report.proyectosAsignados.push(def.name);
    }
    if (def.isApp && !existente.isApp) await setProjectIsApp(existente.id, true);
  }

  return report;
}
