import { createApp } from './app.ts';
import type { Env } from './config.ts';

const app = createApp({
  upstreamFetch: (input, init) => fetch(input, init),
  cache: () => (typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null),
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
