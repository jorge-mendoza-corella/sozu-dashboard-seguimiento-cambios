import { useState, useEffect } from "react";
import { signInWithPopup, signOut, onAuthStateChanged, type User } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { getUserByEmail, seedSuperuser, type AppUser } from "@/lib/firestoreUsers";

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

  return { firebaseUser, appUser, status, login, logout };
}
