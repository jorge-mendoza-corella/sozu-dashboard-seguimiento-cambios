import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2, DollarSign, Building2, GitBranch, Users as UsersIcon,
  Receipt, TrendingUp, AlertTriangle, PieChart, BarChart3, FolderOpen,
} from "lucide-react";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, PointElement, LineElement, ArcElement,
  Tooltip, Legend, Filler, type ChartOptions,
} from "chart.js";
import { Bar, Line, Doughnut } from "react-chartjs-2";
import { Card, CardContent } from "@/components/ui/card";
import { useBillingOverview } from "@/hooks/useClients";
import { useProjects } from "@/hooks/useProjectsRepos";
import { getVisibleUsers , scopeKeyOf} from "@/lib/firestoreUsers";
import { useAuth } from "@/hooks/useAuth";
import { formatMoney, formatMixed, type ClientBillingSummary } from "@/lib/billing";
import type { Currency } from "@/lib/firestoreClients";
import { BAR_COLORS } from "@/lib/colors";

ChartJS.register(
  CategoryScale, LinearScale, BarElement, PointElement, LineElement, ArcElement,
  Tooltip, Legend, Filler,
);

// Slate-400: legible sobre fondo claro y sobre fondo oscuro sin tener que
// escuchar el tema (chart.js pinta en canvas, no le llegan las clases de Tailwind).
const AXIS_COLOR = "rgba(148,163,184,0.95)";
const GRID_COLOR = "rgba(148,163,184,0.15)";

const COLOR_REPOS = BAR_COLORS[0];
const COLOR_EXTRAS = BAR_COLORS[3];
const COLOR_IVA = BAR_COLORS[5];
const COLOR_DESCUENTO = BAR_COLORS[7];
const COLOR_SIN_CLIENTE = "#94a3b8";

const baseTooltip = {
  backgroundColor: "rgba(17,24,39,0.92)",
  padding: 10,
  cornerRadius: 8,
  titleFont: { size: 12, weight: "bold" as const },
  bodyFont: { size: 12 },
};

/** Redondeo a centavos, igual que el motor de cobro. */
const money = (n: number) => Math.round(n * 100) / 100;

/** Color estable por posición para que un cliente no cambie de color al reordenar. */
const colorAt = (i: number) => BAR_COLORS[i % BAR_COLORS.length];

export function SaasAnalytics() {
  // El panel se recorta a lo que el usuario administra: un administrador de
  // empresa ve su propia cuenta, no la cartera completa. Los usuarios se piden
  // con `getVisibleUsers` porque las reglas no le dejan barrer la colección
  // entera: pedir todos le devolvía permission-denied y tumbaba la gráfica.
  const { appUser } = useAuth();
  const { overview, isLoading: cargandoCobro } = useBillingOverview(appUser);
  const { data: projects = [], isLoading: cargandoProyectos } = useProjects();
  const { data: users = [], isLoading: cargandoUsuarios } = useQuery({
    queryKey: ["users-visible", scopeKeyOf(appUser)],
    queryFn: () => getVisibleUsers(appUser),
    staleTime: 60_000,
  });

  const isLoading = cargandoCobro || cargandoProyectos || cargandoUsuarios;

  // ---- Moneda dominante ----------------------------------------------------
  // Nunca se suma MXN con USD: las gráficas de dinero se pintan con la moneda
  // que tiene más clientes (empate: la de mayor MRR) y el resto se avisa aparte.
  const { moneda, dineroClientes, excluidos } = useMemo(() => {
    const porMoneda = (cur: Currency) => overview.byClient.filter((c) => c.currency === cur);
    const mxn = porMoneda("MXN");
    const usd = porMoneda("USD");
    const ganaUsd =
      usd.length > mxn.length ||
      (usd.length === mxn.length && overview.mrrByCurrency.USD > overview.mrrByCurrency.MXN);
    const cur: Currency = ganaUsd ? "USD" : "MXN";
    const propios = ganaUsd ? usd : mxn;
    return {
      moneda: cur,
      dineroClientes: propios,
      excluidos: overview.byClient.length - propios.length,
    };
  }, [overview.byClient, overview.mrrByCurrency]);

  // ---- KPIs derivados ------------------------------------------------------
  const kpis = useMemo(() => {
    const activos = dineroClientes.filter((c) => c.status === "activo");
    const subtotalActivos = money(activos.reduce((acc, c) => acc + c.subtotal, 0));
    const ticketPromedio = activos.length ? money(subtotalActivos / activos.length) : 0;

    const subtotalTotal = money(dineroClientes.reduce((acc, c) => acc + c.subtotal, 0));
    const reposCobrables = dineroClientes.reduce((acc, c) => acc + c.repoCount, 0);
    const precioPorRepo = reposCobrables ? money(subtotalTotal / reposCobrables) : 0;

    return {
      ticketPromedio,
      precioPorRepo,
      superusers: users.filter((u) => u.role === "superuser").length,
    };
  }, [dineroClientes, users]);

  // ---- Gráfica 1: ingreso mensual por cliente ------------------------------
  const porIngreso = useMemo(
    () => [...dineroClientes].sort((a, b) => b.subtotal - a.subtotal),
    [dineroClientes],
  );

  // ---- Gráfica 4: usuarios por cliente ------------------------------------
  // Un usuario "pertenece" a un cliente si alguno de sus `projectIds` es de un
  // proyecto de ese cliente. Los usuarios sin `projectIds` son legacy: ven todo
  // el dashboard, así que no se pueden atribuir a un cliente en particular.
  const usuariosPorCliente = useMemo(() => {
    const conAcceso = users.filter((u) => (u.projectIds?.length ?? 0) > 0);
    const global = users.length - conAcceso.length;

    const filas = overview.byClient.map((c) => {
      const susProyectos = new Set(projects.filter((p) => p.clientId === c.clientId).map((p) => p.id));
      const total = conAcceso.filter((u) => (u.projectIds ?? []).some((id) => susProyectos.has(id))).length;
      return { label: c.clientName, total };
    });

    return { filas: filas.sort((a, b) => b.total - a.total), global };
  }, [users, projects, overview.byClient]);

  // ---- Gráfica 5: proyección a 12 meses -----------------------------------
  // Proyección lineal simple: se repite el MRR activo de hoy mes a mes. Cuando
  // exista histórico de facturación (facturas emitidas/pagadas) hay que
  // sustituir esto por la serie real y proyectar sobre su tendencia.
  const proyeccion = useMemo(() => {
    const mrr = overview.activeMrrByCurrency[moneda];
    const hoy = new Date();
    const labels: string[] = [];
    const mensual: number[] = [];
    const acumulado: number[] = [];
    let suma = 0;
    for (let i = 0; i < 12; i++) {
      const mes = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
      labels.push(mes.toLocaleDateString("es-MX", { month: "short", year: "2-digit" }));
      mensual.push(mrr);
      suma = money(suma + mrr);
      acumulado.push(suma);
    }
    return { labels, mensual, acumulado, mrr };
  }, [overview.activeMrrByCurrency, moneda]);

  // ---- Estados de carga / vacío -------------------------------------------

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" /> Cargando…
      </div>
    );
  }

  if (overview.totalClients === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <Building2 className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-base font-semibold">Todavía no hay clientes</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Crea el primer cliente y asígnale sus proyectos: a partir de ahí el panel
              calcula el ingreso mensual, el desglose del cobro y las proyecciones.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- Aviso de monedas mezcladas -----------------------------------------
  const otraMoneda: Currency = moneda === "MXN" ? "USD" : "MXN";
  const avisoMoneda = excluidos > 0 ? (
    <p className="mt-1 text-xs text-muted-foreground">
      Solo se grafica {moneda}: {excluidos} cliente{excluidos > 1 ? "s" : ""} en {otraMoneda}
      {excluidos > 1 ? " quedan" : " queda"} fuera del gráfico (las monedas no se suman).
    </p>
  ) : null;

  // ---- Opciones de gráficas ------------------------------------------------

  const dineroTick = (v: string | number) => formatMoney(Number(v), moneda);
  const desglose = (c: ClientBillingSummary) =>
    `${c.repoCount} repo${c.repoCount === 1 ? "" : "s"} + ${c.extras.length} extra${c.extras.length === 1 ? "" : "s"}`;

  const ingresoOpts: ChartOptions<"bar"> = {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => ` ${formatMoney(Number(item.raw), moneda)}`,
          afterLabel: (item) => {
            const c = porIngreso[item.dataIndex];
            if (!c) return "";
            return c.currencyMismatch
              ? [desglose(c), `Cobra en ${c.currency}: le falta tarifa propia`]
              : desglose(c);
          },
        },
      },
    },
    scales: {
      x: {
        beginAtZero: true,
        ticks: { font: { size: 10 }, color: AXIS_COLOR, callback: dineroTick },
        grid: { color: GRID_COLOR },
      },
      y: { grid: { display: false }, ticks: { font: { size: 11 }, color: AXIS_COLOR } },
    },
  };

  const hayDescuento = dineroClientes.some((c) => c.discountAmount > 0);
  const composicionOpts: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "top",
        labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, font: { size: 11 }, color: AXIS_COLOR },
      },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => {
            const v = Number(item.raw);
            const monto = formatMoney(Math.abs(v), moneda);
            return ` ${item.dataset.label}: ${v < 0 ? `−${monto}` : monto}`;
          },
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, color: AXIS_COLOR, maxRotation: 45 } },
      y: {
        stacked: true,
        ticks: { font: { size: 10 }, color: AXIS_COLOR, callback: dineroTick },
        grid: { color: GRID_COLOR },
      },
    },
  };

  // Los cobrables por cliente suman `billedRepos` y con los no asignados dan
  // `totalRepos`: el motor garantiza la identidad, así que la dona cuadra con el copy.
  const reposPorCliente = overview.byClient.filter((c) => c.repoCount > 0);
  const reposLabels = [
    ...reposPorCliente.map((c) => c.clientName),
    ...(overview.unassignedRepos > 0 ? ["Sin cliente"] : []),
  ];
  const reposData = [
    ...reposPorCliente.map((c) => c.repoCount),
    ...(overview.unassignedRepos > 0 ? [overview.unassignedRepos] : []),
  ];
  const reposColors = [
    ...reposPorCliente.map((_, i) => colorAt(i)),
    ...(overview.unassignedRepos > 0 ? [COLOR_SIN_CLIENTE] : []),
  ];
  const totalReposGrafica = reposData.reduce((acc, n) => acc + n, 0);

  const reposOpts: ChartOptions<"doughnut"> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: "58%",
    plugins: {
      legend: {
        position: "right",
        labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, font: { size: 11 }, color: AXIS_COLOR },
      },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => {
            const n = Number(item.raw);
            const pct = totalReposGrafica ? Math.round((n / totalReposGrafica) * 100) : 0;
            return ` ${n} repo${n === 1 ? "" : "s"} · ${pct}%`;
          },
        },
      },
    },
  };

  const usuariosLabels = [
    ...usuariosPorCliente.filas.map((f) => f.label),
    ...(usuariosPorCliente.global > 0 ? ["Acceso global"] : []),
  ];
  const usuariosData = [
    ...usuariosPorCliente.filas.map((f) => f.total),
    ...(usuariosPorCliente.global > 0 ? [usuariosPorCliente.global] : []),
  ];
  const usuariosColors = [
    ...usuariosPorCliente.filas.map((_, i) => colorAt(i)),
    ...(usuariosPorCliente.global > 0 ? [COLOR_SIN_CLIENTE] : []),
  ];

  const usuariosOpts: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => {
            const n = Number(item.raw);
            return ` ${n} usuario${n === 1 ? "" : "s"}`;
          },
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 }, color: AXIS_COLOR, maxRotation: 45 } },
      y: {
        beginAtZero: true,
        ticks: { font: { size: 10 }, color: AXIS_COLOR, precision: 0, stepSize: 1 },
        grid: { color: GRID_COLOR },
      },
    },
  };

  const proyeccionOpts: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "top",
        labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, font: { size: 11 }, color: AXIS_COLOR },
      },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => ` ${item.dataset.label}: ${formatMoney(Number(item.raw), moneda)}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 }, color: AXIS_COLOR } },
      y: {
        beginAtZero: true,
        position: "left",
        ticks: { font: { size: 10 }, color: AXIS_COLOR, callback: dineroTick },
        grid: { color: GRID_COLOR },
      },
      y1: {
        beginAtZero: true,
        position: "right",
        ticks: { font: { size: 10 }, color: AXIS_COLOR, callback: dineroTick },
        grid: { display: false },
      },
    },
  };

  // ---- KPI tiles -----------------------------------------------------------

  const tiles: Array<{ label: string; value: string; sub: React.ReactNode; icon: React.ReactNode }> = [
    {
      label: "Ingreso mensual recurrente",
      // El cero se pinta en la moneda dominante: un tenant 100% USD no debe ver pesos.
      value: formatMixed(overview.activeMrrByCurrency, moneda),
      sub: <>Clientes activos, antes de IVA</>,
      icon: <DollarSign className="h-4 w-4 text-emerald-500" />,
    },
    {
      label: "Clientes",
      value: `${overview.activeClients} de ${overview.totalClients}`,
      sub: <>activos sobre el total registrado</>,
      icon: <Building2 className="h-4 w-4 text-sky-500" />,
    },
    {
      label: "Repos cobrables",
      value: `${overview.billedRepos} de ${overview.totalRepos}`,
      sub: overview.unassignedRepos > 0 ? (
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {overview.unassignedRepos} repo{overview.unassignedRepos > 1 ? "s" : ""} sin cliente
        </span>
      ) : (
        <>todos los repos tienen cliente</>
      ),
      icon: <GitBranch className="h-4 w-4 text-indigo-500" />,
    },
    {
      label: "Usuarios del dashboard",
      value: String(users.length),
      sub: <>{kpis.superusers} superuser{kpis.superusers === 1 ? "" : "s"}</>,
      icon: <UsersIcon className="h-4 w-4 text-violet-500" />,
    },
    {
      label: "Ticket promedio",
      value: formatMoney(kpis.ticketPromedio, moneda),
      sub: <>por cliente activo en {moneda}</>,
      icon: <Receipt className="h-4 w-4 text-amber-500" />,
    },
    {
      label: "Precio promedio por repo",
      value: formatMoney(kpis.precioPorRepo, moneda),
      sub: <>subtotal entre repos cobrables</>,
      icon: <TrendingUp className="h-4 w-4 text-rose-500" />,
    },
  ];

  const hayAlertas =
    overview.defaultPriceMissing ||
    overview.reposSinPrecio > 0 ||
    overview.currencyMismatch.length > 0 ||
    overview.missingFiscal.length > 0 ||
    overview.unassignedProjects.length > 0;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2">
                {t.icon}
                <span className="text-xs text-muted-foreground">{t.label}</span>
              </div>
              <p className="text-xl font-bold tabular-nums leading-tight break-words">{t.value}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 1. Ingreso mensual por cliente */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-indigo-500" />
              <h2 className="text-base font-semibold">Ingreso mensual por cliente</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Base gravable de cada cliente (repos + extras − descuento), de mayor a menor.
              Incluye suspendidos y prospectos para ver el potencial completo.
            </p>
            {avisoMoneda}
          </div>
          {porIngreso.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Sin clientes en {moneda}.</p>
          ) : (
            <>
              <div style={{ height: Math.max(200, porIngreso.length * 44) }}>
                <Bar
                  data={{
                    labels: porIngreso.map((c) =>
                      // El asterisco distingue al que está en 0 por falta de tarifa propia,
                      // para que no se lea como que ese cliente no genera ingreso.
                      c.currencyMismatch ? `${c.clientName} *` : c.clientName,
                    ),
                    datasets: [{
                      label: `Subtotal ${moneda}`,
                      data: porIngreso.map((c) => c.subtotal),
                      backgroundColor: porIngreso.map((_, i) => colorAt(i)),
                      borderRadius: 4,
                      maxBarThickness: 22,
                    }],
                  }}
                  options={ingresoOpts}
                />
              </div>
              {porIngreso.some((c) => c.currencyMismatch) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  * Cobra en una moneda distinta a la global, así que no hereda las tarifas
                  default: sus repos y extras están en cero hasta que se le fije tarifa propia.
                  No es que no genere ingreso, es que todavía no tiene precio.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 2. Composición del cobro */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-amber-500" />
              <h2 className="text-base font-semibold">Composición del cobro por cliente</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              De qué está hecho el total de cada factura: lo que aportan los repos, los extras
              contratados y el IVA{hayDescuento ? ", con el descuento restando por debajo del cero" : ""}.
            </p>
            {avisoMoneda}
          </div>
          {dineroClientes.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Sin clientes en {moneda}.</p>
          ) : (
            <div className="h-72">
              <Bar
                data={{
                  labels: dineroClientes.map((c) => c.clientName),
                  datasets: [
                    {
                      label: "Repos",
                      data: dineroClientes.map((c) => c.reposSubtotal),
                      backgroundColor: COLOR_REPOS,
                      borderRadius: 3,
                      maxBarThickness: 40,
                    },
                    {
                      label: "Extras",
                      data: dineroClientes.map((c) => c.extrasSubtotal),
                      backgroundColor: COLOR_EXTRAS,
                      borderRadius: 3,
                      maxBarThickness: 40,
                    },
                    {
                      label: "IVA",
                      data: dineroClientes.map((c) => c.taxAmount),
                      backgroundColor: COLOR_IVA,
                      borderRadius: 3,
                      maxBarThickness: 40,
                    },
                    // El descuento va como dataset negativo: se ve restando hacia abajo.
                    ...(hayDescuento ? [{
                      label: "Descuento",
                      data: dineroClientes.map((c) => -c.discountAmount),
                      backgroundColor: COLOR_DESCUENTO,
                      borderRadius: 3,
                      maxBarThickness: 40,
                    }] : []),
                  ],
                }}
                options={composicionOpts}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* 3. Repos por cliente */}
        <Card>
          <CardContent className="p-5">
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <PieChart className="h-5 w-5 text-cyan-500" />
                <h2 className="text-base font-semibold">Repos por cliente</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Reparto de los {overview.totalRepos} repos monitoreados: {overview.billedRepos} con
                cliente
                {overview.unassignedRepos > 0
                  ? ` y ${overview.unassignedRepos} sin asignar`
                  : ""}. Sin moneda de por medio: aquí se cuentan todos los clientes.
              </p>
            </div>
            {totalReposGrafica === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Todavía no hay repos monitoreados.</p>
            ) : (
              <div className="h-72">
                <Doughnut
                  data={{
                    labels: reposLabels,
                    datasets: [{
                      label: "Repos",
                      data: reposData,
                      backgroundColor: reposColors,
                      borderWidth: 0,
                    }],
                  }}
                  options={reposOpts}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* 4. Usuarios por cliente */}
        <Card>
          <CardContent className="p-5">
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <UsersIcon className="h-5 w-5 text-violet-500" />
                <h2 className="text-base font-semibold">Usuarios por cliente</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Cuántas cuentas del dashboard tienen acceso a algún proyecto de cada cliente.
                Las cuentas sin proyectos asignados son legacy (ven todo) y van en «Acceso global».
              </p>
            </div>
            {usuariosData.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Sin usuarios registrados.</p>
            ) : (
              <div className="h-72">
                <Bar
                  data={{
                    labels: usuariosLabels,
                    datasets: [{
                      label: "Usuarios",
                      data: usuariosData,
                      backgroundColor: usuariosColors,
                      borderRadius: 4,
                      maxBarThickness: 40,
                    }],
                  }}
                  options={usuariosOpts}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 5. Proyección a 12 meses */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-emerald-500" />
              <h2 className="text-base font-semibold">Proyección de ingresos a 12 meses</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Proyección lineal simple: se repite el MRR activo de hoy
              ({formatMoney(proyeccion.mrr, moneda)}) mes a mes y se acumula. Mientras no haya
              histórico de facturación no hay tendencia real que extrapolar: no asume altas,
              bajas ni cambios de precio.
            </p>
            {avisoMoneda}
          </div>
          <div className="h-72">
            <Line
              data={{
                labels: proyeccion.labels,
                datasets: [
                  {
                    label: `MRR mensual ${moneda}`,
                    data: proyeccion.mensual,
                    borderColor: COLOR_REPOS,
                    backgroundColor: "transparent",
                    fill: false,
                    tension: 0,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    yAxisID: "y",
                  },
                  {
                    label: `Acumulado ${moneda}`,
                    data: proyeccion.acumulado,
                    borderColor: "#10b981",
                    backgroundColor: "rgba(16,185,129,0.14)",
                    fill: true,
                    tension: 0.25,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    yAxisID: "y1",
                  },
                ],
              }}
              options={proyeccionOpts}
            />
          </div>
        </CardContent>
      </Card>

      {/* Alertas: lo que hay que arreglar para poder cobrar y facturar */}
      {hayAlertas && (
        <Card className="border-amber-300 bg-amber-50/40 dark:bg-amber-950/10">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h2 className="text-base font-semibold text-amber-800 dark:text-amber-300">
                Pendientes de configuración
              </h2>
            </div>

            {overview.defaultPriceMissing && (
              <div className="mb-4 rounded-md border border-red-300 bg-red-50/70 p-3 dark:border-red-900 dark:bg-red-950/20">
                <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                  No hay tarifa por repo configurada
                </p>
                <p className="mt-1 text-xs text-red-700/90 dark:text-red-300/90">
                  Hay repos heredando el default global y ese default es {formatMoney(0, moneda)},
                  así que no se está cobrando nada. Fija la tarifa por repo en la pestaña
                  «Precios y features» o dale precio propio a cada repo.
                </p>
              </div>
            )}

            {overview.reposSinPrecio > 0 && (
              <div className="mb-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  {overview.reposSinPrecio} repo{overview.reposSinPrecio > 1 ? "s" : ""} de clientes
                  activos en {formatMoney(0, moneda)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Se están monitoreando pero no entran al MRR: nadie los está cobrando. Ponles
                  precio en el repo o fíjale una tarifa por repo al cliente en «Precios y features».
                </p>
              </div>
            )}

            {overview.currencyMismatch.length > 0 && (
              <div className="mb-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  {overview.currencyMismatch.length} cliente
                  {overview.currencyMismatch.length > 1 ? "s cobran" : " cobra"} en una moneda
                  distinta a la global
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  No pueden heredar los montos default (serían pesos cobrados como dólares), así
                  que sus repos y extras quedan en cero hasta que se les fije tarifa propia en
                  «Precios y features».
                </p>
                <ul className="space-y-1">
                  {overview.currencyMismatch.map((c) => (
                    <li key={c.clientId} className="flex items-center gap-2 text-sm">
                      <DollarSign className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="truncate">{c.clientName}</span>
                      <span className="text-xs text-muted-foreground">
                        · cobra en {c.currency} · {formatMoney(c.total, c.currency)} {c.currency} al mes
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {overview.missingFiscal.length > 0 && (
              <div className="mb-4">
                <p className="text-sm font-medium">
                  {overview.missingFiscal.length} cliente{overview.missingFiscal.length > 1 ? "s" : ""} activo
                  {overview.missingFiscal.length > 1 ? "s" : ""} sin datos fiscales
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Falta RFC, régimen fiscal o código postal: sin los tres no se puede timbrar la
                  factura. Complétalos en la ficha del cliente → Datos fiscales.
                </p>
                <ul className="space-y-1">
                  {overview.missingFiscal.map((c) => (
                    <li key={c.clientId} className="flex items-center gap-2 text-sm">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="truncate">{c.clientName}</span>
                      <span className="text-xs text-muted-foreground">
                        · {formatMoney(c.total, c.currency)} {c.currency} al mes
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {overview.unassignedProjects.length > 0 && (
              <div>
                <p className="text-sm font-medium">
                  {overview.unassignedProjects.length} proyecto
                  {overview.unassignedProjects.length > 1 ? "s" : ""} sin cliente
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Sus repos no se le cobran a nadie y no entran al MRR. Asígnales un cliente en
                  la configuración del proyecto.
                </p>
                <ul className="space-y-1">
                  {overview.unassignedProjects.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="truncate">{p.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
