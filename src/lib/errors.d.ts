export declare class HapioError extends Error {
  status: number;
  data: any;
  headers: Record<string, string>;

  constructor(
    message: string,
    details?: { status: number; data: any; headers?: Record<string, string> },
  );
}

