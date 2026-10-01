export class HapioError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, data: any, headers?: Record<string, string> }} details
   */
  constructor(message, { status, data, headers } = {}) {
    super(message);
    this.name = "HapioError";
    this.status = status ?? 0;
    this.data = data;
    this.headers = headers ?? {};
  }
}

