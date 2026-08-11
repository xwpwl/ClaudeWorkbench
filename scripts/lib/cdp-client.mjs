const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

function stringifyMessageData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#handleMessage(event));
    socket.addEventListener('close', () => this.#handleClose());
    socket.addEventListener('error', () => this.#handleClose());
  }

  static async connect(webSocketDebuggerUrl, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (typeof WebSocket !== 'function') {
      throw new Error('Electron acceptance requires Node.js 22+ (global WebSocket is unavailable).');
    }
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Electron CDP.')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Electron CDP WebSocket connection failed.'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async send(method, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.#closed) throw new Error(`CDP is closed; cannot send ${method}.`);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  async evaluate(expression, options = {}) {
    const { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...protocolOptions } = options;
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...protocolOptions,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'Renderer evaluation failed.';
      throw new Error(description);
    }
    return response.result?.value;
  }

  async waitFor(expression, {
    description = expression,
    timeoutMs = 15_000,
    intervalMs = 75,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const suffix = lastError ? ` Last renderer error: ${lastError.message}` : '';
    throw new Error(`Timed out waiting for ${description}.${suffix}`);
  }

  async dispatchShortcut({ key, code, windowsVirtualKeyCode, modifiers }) {
    const common = {
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
    this.#rejectPending(new Error('CDP client closed.'));
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(stringifyMessageData(event.data));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    const listeners = this.#listeners.get(message.method);
    if (!listeners) return;
    for (const listener of listeners) listener(message.params ?? {});
  }

  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error('Electron CDP connection closed.'));
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export async function waitForCdpPage(port, {
  timeoutMs = 30_000,
  processExited = () => false,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (processExited()) throw new Error('Electron exited before its renderer became available.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page'
          && typeof target.webSocketDebuggerUrl === 'string'
          && (target.title === 'Claude Workbench' || /renderer\/index\.html|localhost:5173/.test(target.url)));
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const suffix = lastError ? ` Last connection error: ${lastError.message}` : '';
  throw new Error(`Timed out locating the real Workbench renderer on CDP port ${port}.${suffix}`);
}
