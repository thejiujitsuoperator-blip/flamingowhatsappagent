/** Abstraction over the WhatsApp connection so the rest of the app (and tests) don't depend on Baileys. */
export interface MessageTransport {
  /** Sends a text message and returns the WhatsApp message id. */
  sendText(jid: string, text: string): Promise<string | null>;
  /** Shows "typing..." to the recipient (best effort). */
  sendTyping?(jid: string): Promise<void>;
  isConnected(): boolean;
  /** True when the message id belongs to a message this process sent. */
  isOwnMessage(id: string): boolean;
}
