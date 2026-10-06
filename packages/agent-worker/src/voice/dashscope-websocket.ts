import WebSocket, { type RawData } from "ws";

export interface ProviderWebSocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type ProviderWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => ProviderWebSocket;

export const createProviderWebSocket: ProviderWebSocketFactory = (
  url,
  headers,
) => new WebSocket(url, { headers });

export class AsyncEventQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(value);
    } else {
      this.#values.push(value);
    }
  }

  async next(): Promise<T> {
    const value = this.#values.shift();
    if (value !== undefined) {
      return value;
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export function parseDashScopeMessage(data: RawData): unknown {
  return JSON.parse(data.toString()) as unknown;
}

export function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function createTaskId(): string {
  return crypto.randomUUID();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function eventName(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.header)) {
    return undefined;
  }
  return typeof value.header.event === "string"
    ? value.header.event
    : undefined;
}
