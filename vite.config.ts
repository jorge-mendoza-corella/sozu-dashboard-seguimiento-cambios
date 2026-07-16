import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Versión del build: <major>.<minor>.<año>.<mmdd>.<hhmm> (hora México).
// Cada deploy genera una nueva versión automáticamente; el prefijo se sube
// a mano cuando haya un cambio mayor.
const VERSION_PREFIX = "1.0";
const mx = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
const p2 = (n: number) => String(n).padStart(2, "0");
const APP_VERSION = `${VERSION_PREFIX}.${mx.getFullYear()}.${p2(mx.getMonth() + 1)}${p2(mx.getDate())}.${p2(mx.getHours())}${p2(mx.getMinutes())}`;

export default defineConfig({
  define: {
    __APP_BUILD__: JSON.stringify(APP_VERSION),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { port: 8081 },
});
