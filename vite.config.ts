import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  define: {
    // Sello de versión del bundle (hora México) — visible en la UI para
    // detectar cuándo el navegador sirve un bundle cacheado viejo.
    __APP_BUILD__: JSON.stringify(
      new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City", hour12: false }),
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { port: 8081 },
});
