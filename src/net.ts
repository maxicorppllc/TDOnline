// WebSocket connection to the game server, with automatic reconnect.

import type { ClientMsg, ServerMsg } from './protocol.ts';

export class Net {
  ws: WebSocket | null = null;
  connected = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  private hello: () => ClientMsg;
  private retry = 0;

  constructor(hello: () => ClientMsg) {
    this.hello = hello;
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.send(this.hello());
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      if (was) this.onStatus(false);
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.connect(), 2000);
  }

  send(m: ClientMsg): void {
    if (this.ws && this.connected) this.ws.send(JSON.stringify(m));
  }
}
