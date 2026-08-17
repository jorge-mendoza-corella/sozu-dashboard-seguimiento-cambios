import { TrendingUp } from "lucide-react";
import { SaasAnalytics } from "@/components/analytics/SaasAnalytics";

/**
 * Panel de negocio: cuánto factura el servicio, por qué cliente, cuántos repos
 * se cobran y quién tiene acceso. Es la vista de dueño del SaaS, separada del
 * CI/CD (que es la vista de operación).
 */
export function NegocioPage() {
  return (
    <div className="p-6">
      <div className="mb-5">
        <div className="mb-1 flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          <h1 className="text-xl font-bold tracking-tight">Negocio</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Ingresos por cliente, repos cobrados y usuarios del servicio.
        </p>
      </div>
      <SaasAnalytics />
    </div>
  );
}
