import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { ImpersonationProvider } from "@/components/ImpersonationProvider";
import { canAdminister, isRootAdmin } from "@/lib/firestoreUsers";
import { setSessionGithubAuth } from "@/lib/github";
import { AppLayout } from "@/components/AppLayout";
import { GithubTokenGate } from "@/components/GithubTokenGate";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { UsersPage } from "@/pages/UsersPage";
import { ContributorsPage } from "@/pages/ContributorsPage";
import { ResumenPage } from "@/pages/ResumenPage";
import { ConfiguracionPage } from "@/pages/ConfiguracionPage";
import { NegocioPage } from "@/pages/NegocioPage";

const queryClient = new QueryClient();

function AppRoutes() {
  const { status, appUser, realUser, logout } = useAuth();
  // El usuario acaba de registrar su API key en el gate (el doc de Firestore
  // ya se actualizó, pero appUser en memoria sigue sin token).
  const [tokenJustSaved, setTokenJustSaved] = useState(false);

  // Token de GitHub de QUIEN ESTÁ SENTADO AQUÍ, nunca el del suplantado:
  // "ver como" simula lo que alguien VE, y las escrituras se hacen de verdad —
  // salir a GitHub como esa persona sería firmar sus PRs y merges con su cuenta.
  useEffect(() => {
    setSessionGithubAuth(realUser?.githubToken ?? null, realUser?.githubLogin ?? null);
  }, [realUser?.githubToken, realUser?.githubLogin]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }
  if (status === "unauthenticated" || status === "unauthorized") {
    return <LoginPage />;
  }

  // Contribuidores y Usuarios: solo el superusuario raíz (jorge.mendoza@sozu.com).
  // (Bloqueado también por URL directa.)
  const isRoot = isRootAdmin(appUser);
  // Quién eres no cambia por estar viendo como alguien más: el gate y el guardado
  // de la API key miran SIEMPRE al usuario real. Cuando miraban el perfil
  // efectivo, el root impersonando a un usuario con rol de empresa dejaba de ser
  // "root exento" y el gate le pedía una API key: la que registrara se guardaba
  // en SU documento (la impersonación conserva el correo), y a partir de ahí el
  // dashboard salía a GitHub con la cuenta de otra persona.
  const isRootReal = isRootAdmin(realUser);
  const esAdminGlobal = isRoot || appUser?.role === "superuser";
  const puedeAdministrar = canAdminister(appUser);

  // Gate obligatorio: sin API key de GitHub no se puede usar nada (root exento).
  if (realUser && !isRootReal && !realUser.githubToken && !tokenJustSaved) {
    return (
      <GithubTokenGate
        email={realUser.email}
        logout={logout}
        onUnlocked={() => setTokenJustSaved(true)}
      />
    );
  }

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/resumen" element={<ResumenPage />} />
        <Route path="/contributors" element={puedeAdministrar ? <ContributorsPage /> : <Navigate to="/" replace />} />
        {/* Usuarios, Negocio y Configuración las abre cualquier administrador:
            el global ve todo el servicio y el de empresa solo sus clientes
            (cada pantalla se recorta sola con `useClientScope`). Negocio y
            Configuración no: son del dueño del servicio y solo las abre el
            admin global. Las reglas de Firestore repiten el corte, así que
            esconder no es la única defensa. */}
        <Route path="/users" element={puedeAdministrar ? <UsersPage /> : <Navigate to="/" replace />} />
        {/* Negocio expone tarifas y datos fiscales de toda la cartera: es del
            admin global, no del administrador de empresa. */}
        <Route path="/negocio" element={esAdminGlobal ? <NegocioPage /> : <Navigate to="/" replace />} />
        <Route path="/configuracion" element={puedeAdministrar ? <ConfiguracionPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Por encima de todo: `useAuth` lee de aquí para devolver el perfil con
          el que se está viendo el dashboard. */}
      <ImpersonationProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ImpersonationProvider>
    </QueryClientProvider>
  );
}
