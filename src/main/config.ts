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
  targetUrl: process.env.TARGET_URL || "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2",
  outputFolder: process.env.OUTPUT_FOLDER || "out",
  userAgent: (process.env.USER_AGENT || "").trim() || null,
  winWidth: parseInt(process.env.WIN_WIDTH || "1366", 10),
  winHeight: parseInt(process.env.WIN_HEIGHT || "768", 10)
};
