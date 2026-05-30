// mobile/lib/websocket.ts
// Prototype transport: phone ↔ ESP32 over local WiFi (port 81).
// Full product will swap this for Supabase Realtime — only this file changes.
//
// Usage:
//   const conn = new DeviceConnection(onMessage, onStatusChange);
//   conn.connect("192.168.1.42");
//   conn.sendLetter("H");
//   conn.disconnect();

// ── Types ─────────────────────────────────────────────────────────────────────

export type ButtonPress = "next" | "back" | "answer";

/** Every message the ESP32 can send to the phone. */
export type DeviceMessage =
  | { type: "ready" }
  | { type: "button_press"; button: ButtonPress };

/** Every message the phone can send to the ESP32. */
export type AppMessage =
  | { type: "display"; letter: string };

type OnMessage = (msg: DeviceMessage) => void;
type OnStatusChange = (connected: boolean) => void;

// ── DeviceConnection ──────────────────────────────────────────────────────────

export class DeviceConnection {
  private ws: WebSocket | null = null;
  private readonly onMessage: OnMessage;
  private readonly onStatusChange: OnStatusChange;

  constructor(onMessage: OnMessage, onStatusChange: OnStatusChange) {
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  /** Open a WebSocket connection to ws://{ip}:81 */
  connect(ip: string): void {
    this.disconnect(); // close any existing socket first

    const socket = new WebSocket(`ws://${ip.trim()}:81`);

    socket.onopen = () => {
      this.ws = socket;
      this.onStatusChange(true);
    };

    socket.onclose = () => {
      this.ws = null;
      this.onStatusChange(false);
    };

    socket.onerror = () => {
      this.ws = null;
      this.onStatusChange(false);
    };

    socket.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as DeviceMessage;
        this.onMessage(msg);
      } catch {
        console.warn("[DeviceConnection] Unparseable message:", e.data);
      }
    };
  }

  /**
   * Send a single letter to the ESP32 for display on the solenoids.
   * Silently no-ops if the socket is not open.
   */
  sendLetter(letter: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: AppMessage = { type: "display", letter: letter.toUpperCase() };
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Close the WebSocket gracefully. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}