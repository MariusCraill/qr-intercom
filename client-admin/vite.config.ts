import { defineConfig } from "vite";
import fs from "fs";
import path from "path";
import { backendProxy } from "../dev-backend";

const certDir = path.resolve(__dirname, "../certs");

export default defineConfig({
  base: "/admin/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5175,
    https: {
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    },
    proxy: backendProxy(path.resolve(__dirname, "..")),
  },
});
