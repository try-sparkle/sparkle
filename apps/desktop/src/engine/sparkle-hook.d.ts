// Type surface for the shipped emitter script (a plain .mjs with no companion .d.ts).
// Only the pure normalizer is imported by tests; the runtime entrypoint has no exports.
declare module "*/sparkle-hook.mjs" {
  export function normalize(
    payload: unknown,
    ts: number,
  ): { ts: number; event: string; tool?: string; message?: string; session_id?: string };
}
