/**
 * @file src/main/config.ts
 * @brief Carrega variáveis de ambiente e expõe a configuração tipada.
 */
import dotenv from "dotenv";
dotenv.config();

export interface AppConfig {
  targetUrl: string;
  outputFolder: string;
  userAgent: string | null;
  winWidth: number;
  winHeight: number;
}

export const config: AppConfig = {
  targetUrl: process.env.TARGET_URL || "https://google.com",
  outputFolder: process.env.OUTPUT_FOLDER || "out",
  userAgent: (process.env.USER_AGENT || "").trim() || null,
  winWidth: parseInt(process.env.WIN_WIDTH || "1366", 10),
  winHeight: parseInt(process.env.WIN_HEIGHT || "768", 10)
};
