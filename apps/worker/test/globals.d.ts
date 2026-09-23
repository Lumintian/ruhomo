// Test-only convenience: response bodies in assertions are read as `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
export {};
