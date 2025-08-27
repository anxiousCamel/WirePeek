import { session, type Session } from "electron";

export const WIREPEEK_PARTITION = "persist:wirepeek";

/** Session que será compartilhada entre janela principal e webviews */
export function createUserSession(): Session {
  // cache:true mantém cache entre execuções; troque se quiser isolado
  const ses = session.fromPartition(WIREPEEK_PARTITION, { cache: true });
  return ses;
}
