import { useEffect, useMemo, useState } from "react";
import { signInWithPopup, signOut, onAuthStateChanged, type User } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { useQuery } from "@tanstack/react-query";
import { getUserByEmail, seedSuperuser, SUPERUSER_EMAIL, type AppUser } from "@/lib/firestoreUsers";
import { applyImpersonation, useImpersonation } from "./useImpersonation";

type AuthState = "loading" | "unauthenticated" | "unauthorized" | "authorized";

export function useAuth() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [status, setStatus] = useState<AuthState>("loading");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) { setStatus("unauthenticated"); setAppUser(null); return; }
      try {
        await seedSuperuser();
      } catch {
        // El documento ya existe o no tiene permisos de creación — continuar
      }
      try {
        const profile = await getUserByEmail(user.email!);
        if (!profile) { setStatus("unauthorized"); setAppUser(null); return; }
        setAppUser(profile);
        setStatus("authorized");
      } catch {
        setStatus("unauthorized");
        setAppUser(null);
      }
    });
    return unsub;
  }, []);

  const login = () => signInWithPopup(auth, googleProvider);
  const logout = () => signOut(auth);

  // "Ver como" un usuario: el perfil que sale de aquí es el que usan TODAS las
  // pantallas, así que aplicando la impersonación en este punto el recorte, la
  // marca y los menús se acomodan solos. `realUser` queda expuesto para lo que
  // necesite saber quién es de verdad (el banner y el propio selector).
  const { email: viendoComo } = useImpersonation();
  // El doc del suplantado se pide aparte: solo el root puede leer usuarios
  // ajenos, y si la lectura falla se sigue viendo como uno mismo.
  const { data: suplantado } = useQuery({
    queryKey: ["impersonado", viendoComo],
    queryFn: () => getUserByEmail(viendoComo!).catch(() => null),
    enabled: !!viendoComo && appUser?.email === SUPERUSER_EMAIL,
    // Sin caché: este doc DEFINE lo que se ve, y "ver como" se usa justo después
    // de cambiarle el rol o las empresas a alguien. Con el perfil guardado un
    // minuto, el root acababa mirando la sesión anterior de esa persona —menús
    // de administración incluidos— y creyendo que el cambio no había servido.
    staleTime: 0,
    refetchOnMount: "always",
  });
  // Memoizado a propósito: `applyImpersonation` arma un objeto nuevo, y este
  // perfil es dependencia de casi todos los `useMemo` de la app. Sin estabilizar
  // la identidad, cada render rehacía esos memos, `ContributorsPage` volvía a
  // disparar su efecto de carga y la pantalla se quedaba cargando para siempre.
  const efectivo = useMemo(
    () => applyImpersonation(appUser, viendoComo ? suplantado : null),
    [appUser, viendoComo, suplantado],
  );

  return {
    firebaseUser,
    appUser: efectivo,
    realUser: appUser,
    impersonando: efectivo !== appUser ? viendoComo : null,
    status,
    login,
    logout,
  };
}
