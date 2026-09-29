/** Source-independent representation of one 1:1 WhatsApp chat's history. */
export interface HistoryMessage {
  /** Stable id used for de-duplication (real WhatsApp id, or a deterministic hash for exports). */
  id: string;
  /** true = sent by the gym's WhatsApp account. */
  fromMe: boolean;
  text: string;
  timestamp: Date;
}

export interface HistoryChat {
  /** Label used in reports (file name or JID). */
  label: string;
  jid: string | null;
  phone: string | null;
  name: string | null;
  messages: HistoryMessage[];
}

/** A chat the parser could not turn into a HistoryChat, reported back to the user. */
export interface SkippedSource {
  label: string;
  reason: string;
}
