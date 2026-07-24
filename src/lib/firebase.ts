import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// authDomain: el site default del proyecto (sozu-admin-dev.firebaseapp.com)
// lo ocupa la app SOZU Admin, que responde su SPA/404 en /__/auth/handler y
// rompe los popups de OAuth con scopes extra. El handler debe correr en el
// dominio del PROPIO dashboard (site sozu-dashboard-dev).
const AUTH_DOMAIN = "dashboard.sozu.com";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
