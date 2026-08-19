import { useState, useEffect } from "react";
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
    staleTime: 60 * 1000,
  });
  const efectivo = applyImpersonation(appUser, viendoComo ? suplantado : null);

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
