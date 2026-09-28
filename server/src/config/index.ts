export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Config {
  port: number;
  httpPort: number;
  host: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  databasePath: string;
  turnServers: IceServer[];
  corsOrigins: string[];
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    httpPort: parseInt(process.env.HTTP_PORT || "3010", 10),
    host: process.env.HOST || "0.0.0.0",
    jwtSecret: process.env.JWT_SECRET || "change-me-in-production-use-openssl-rand-base64-32",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    databasePath: process.env.DATABASE_PATH || "./data/intercom.db",
    turnServers: JSON.parse(process.env.TURN_SERVERS || "[]"),
    corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174,https://desktop-obtdcvt.tail973ab1.ts.net").split(","),
  };
}
