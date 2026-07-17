import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { setSessionGithubAuth } from "@/lib/github";
import { AppLayout } from "@/components/AppLayout";
import { GithubTokenGate } from "@/components/GithubTokenGate";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { UsersPage } from "@/pages/UsersPage";
import { ContributorsPage } from "@/pages/ContributorsPage";
import { ResumenPage } from "@/pages/ResumenPage";

const queryClient = new QueryClient();

function AppRoutes() {
  const { status, appUser, logout } = useAuth();
  // El usuario acaba de registrar su API key en el gate (el doc de Firestore
  // ya se actualizó, pero appUser en memoria sigue sin token).
  const [tokenJustSaved, setTokenJustSaved] = useState(false);

  // Activar el token de sesión de GitHub del usuario logueado.
  useEffect(() => {
    setSessionGithubAuth(appUser?.githubToken ?? null, appUser?.githubLogin ?? null);
  }, [appUser?.githubToken, appUser?.githubLogin]);

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
  const isRoot = appUser?.email === SUPERUSER_EMAIL;

  // Gate obligatorio: sin API key de GitHub no se puede usar nada (root exento).
  if (appUser && !isRoot && !appUser.githubToken && !tokenJustSaved) {
    return (
      <GithubTokenGate
        email={appUser.email}
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
        <Route path="/contributors" element={isRoot ? <ContributorsPage /> : <Navigate to="/" replace />} />
        <Route path="/users" element={isRoot ? <UsersPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
