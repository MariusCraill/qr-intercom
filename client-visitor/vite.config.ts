import { defineConfig } from "vite";
import fs from "fs";
import path from "path";

const certDir = path.resolve(__dirname, "../certs");

export default defineConfig({
  base: "/visit/",
  appType: "spa",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: {
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    },
    proxy: {
      "/api": {
        target: "https://localhost:3000",
        secure: false,
      },
      "/ws": {
        target: "wss://localhost:3000",
        ws: true,
        secure: false,
      },
    },
  },
});
