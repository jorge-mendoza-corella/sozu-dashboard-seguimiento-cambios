import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { UsersPage } from "@/pages/UsersPage";
import { ContributorsPage } from "@/pages/ContributorsPage";

const queryClient = new QueryClient();

function AppRoutes() {
  const { status, appUser } = useAuth();

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

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
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
