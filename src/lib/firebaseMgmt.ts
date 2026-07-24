// ---------------------------------------------------------------------------
// Firebase Management API — leer proyectos Firebase y los packages de sus
// apps con la MISMA cuenta Google del usuario logueado (scope de solo
// lectura pedido on-demand con un popup). Nada de credenciales nuevas:
// cada quien ve únicamente los proyectos Firebase a los que su cuenta
// Google tiene acceso real.
// ---------------------------------------------------------------------------
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth } from "./firebase";

const API = "https://firebase.googleapis.com/v1beta1";

// Token de Google (no confundir con el idToken de Firebase Auth) cacheado en
// memoria; dura ~1 h. Se obtiene con un popup que pide el scope readonly.
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getGoogleFirebaseToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const provider = new GoogleAuthProvider();
  provider.addScope("https://www.googleapis.com/auth/firebase.readonly");
  provider.setCustomParameters({ prompt: "consent" });
  const result = await signInWithPopup(auth, provider);
  const cred = GoogleAuthProvider.credentialFromResult(result);
  if (!cred?.accessToken) throw new Error("No se obtuvo el token de Google.");
  cachedToken = { value: cred.accessToken, expiresAt: Date.now() + 50 * 60 * 1000 };
  return cred.accessToken;
}

async function mgmt<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Firebase Management API ${res.status}`);
  return res.json() as Promise<T>;
}

export interface FirebaseProjectInfo {
  projectId: string;
  displayName: string;
}

/** Proyectos Firebase a los que la cuenta Google del usuario tiene acceso. */
export async function listFirebaseProjects(token: string): Promise<FirebaseProjectInfo[]> {
  const data = await mgmt<{ results?: Array<{ projectId: string; displayName?: string }> }>(
    token,
    "/projects?pageSize=100",
  );
  return (data.results ?? []).map((p) => ({
    projectId: p.projectId,
    displayName: p.displayName ?? p.projectId,
  }));
}

export interface FirebaseAppPackage {
  packageName: string;
  displayName?: string;
  platform: "android" | "ios";
}

/** Packages (Android applicationId / iOS bundleId) de las apps de un proyecto. */
export async function listProjectPackages(token: string, projectId: string): Promise<FirebaseAppPackage[]> {
  const [android, ios] = await Promise.all([
    mgmt<{ apps?: Array<{ packageName: string; displayName?: string }> }>(
      token, `/projects/${projectId}/androidApps?pageSize=100`,
    ).catch(() => ({ apps: [] })),
    mgmt<{ apps?: Array<{ bundleId: string; displayName?: string }> }>(
      token, `/projects/${projectId}/iosApps?pageSize=100`,
    ).catch(() => ({ apps: [] })),
  ]);
  return [
    ...(android.apps ?? []).map((a) => ({ packageName: a.packageName, displayName: a.displayName, platform: "android" as const })),
    ...(ios.apps ?? []).map((a) => ({ packageName: a.bundleId, displayName: a.displayName, platform: "ios" as const })),
  ];
}
