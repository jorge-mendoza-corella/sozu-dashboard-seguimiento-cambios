import { useState, useEffect, useCallback } from "react";
import { Users, GitCommit, GitBranch, Phone, ExternalLink, X, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { fetchContributors, type Contributor } from "@/lib/github";
import { getAllContributorPhones, saveContributorPhone } from "@/lib/firestoreContributors";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContributorsAnalytics } from "@/components/analytics/ContributorsAnalytics";
import { BAR_COLORS } from "@/lib/colors";

const TEL_REGEX = /^\d{10}$/;

function DetailModal({
  contributor,
  telefonoActual,
  onClose,
  onSaved,
}: {
  contributor: Contributor;
  telefonoActual?: string;
  onClose: () => void;
  onSaved: (login: string, telefono: string) => void;
}) {
  const { appUser } = useAuth();
  const [telefono, setTelefono] = useState(telefonoActual ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const maxCommits = Math.max(...contributor.repos.map((r) => r.contributions), 1);

  const handleSave = async () => {
    const tel = telefono.trim();
    if (!TEL_REGEX.test(tel)) {
      setError("El teléfono debe tener exactamente 10 dígitos");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await saveContributorPhone(contributor.login, tel, appUser?.email ?? "desconocido");
      onSaved(contributor.login, tel);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          {/* Header */}
          <div className="flex items-start gap-4">
            <img
              src={contributor.avatarUrl}
              alt={contributor.login}
              className="h-14 w-14 rounded-full border"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold truncate">{contributor.login}</h2>
                <a
                  href={contributor.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              <p className="text-sm text-muted-foreground">
                {contributor.totalContributions.toLocaleString()} commits ·{" "}
                {contributor.repos.length} repos
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Gráfica de barras (CSS) */}
          <div className="mt-6 space-y-2">
            <p className="text-sm font-medium">Commits por repositorio</p>
            {contributor.repos.map((r, i) => (
              <div key={r.repo} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-xs text-muted-foreground" title={r.repo}>
                  {r.repo}
                </span>
                <div className="flex-1 h-5 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full rounded flex items-center justify-end pr-2 text-[10px] font-medium text-white"
                    style={{
                      width: `${Math.max((r.contributions / maxCommits) * 100, 8)}%`,
                      backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                    }}
                  >
                    {r.contributions.toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Teléfono WhatsApp */}
          <div className="mt-6 border-t pt-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4" /> Teléfono de WhatsApp
            </label>
            <div className="mt-2 flex gap-2">
              <input
                inputMode="numeric"
                maxLength={10}
                className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
                placeholder="10 dígitos"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
              <Button onClick={handleSave} disabled={saving} size="sm">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : ok ? <Check className="h-4 w-4" /> : "Guardar"}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive mt-2">{error}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ContributorsPage() {
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Contributor | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [contribs, phoneMap] = await Promise.all([
        fetchContributors(),
        getAllContributorPhones().catch(() => ({})),
      ]);
      setContributors(contribs);
      setPhones(phoneMap);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cargar contribuidores");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = (login: string, telefono: string) => {
    setPhones((prev) => ({ ...prev, [login]: telefono }));
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center gap-2">
        <GitBranch className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Contribuidores</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Contribuidores de GitHub agregados de todos los repositorios monitoreados
          </p>
        </div>
      </div>

      <Tabs defaultValue="lista">
        <TabsList>
          <TabsTrigger value="lista">Contribuidores</TabsTrigger>
          <TabsTrigger value="analitica">Analítica ejecutiva</TabsTrigger>
        </TabsList>

        <TabsContent value="lista">
          {error && (
            <Card className="mb-6 border-destructive">
              <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando contribuidores…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {contributors.map((c) => (
                <Card
                  key={c.login}
                  className="cursor-pointer transition-shadow hover:shadow-md"
                  onClick={() => setSelected(c)}
                >
                  <CardContent className="flex items-center gap-4 p-4">
                    <img src={c.avatarUrl} alt={c.login} className="h-12 w-12 rounded-full border" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{c.login}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <GitCommit className="h-3 w-3" />
                          {c.totalContributions.toLocaleString()} commits
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {c.repos.length} repos
                        </span>
                      </div>
                      {phones[c.login] && (
                        <Badge variant="secondary" className="mt-2 gap-1">
                          <Phone className="h-3 w-3" />
                          {phones[c.login]}
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="analitica">
          <ContributorsAnalytics />
        </TabsContent>
      </Tabs>

      {selected && (
        <DetailModal
          contributor={selected}
          telefonoActual={phones[selected.login]}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
