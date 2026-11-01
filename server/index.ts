import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { loadEpisodes } from './store.ts';

await loadEpisodes();

serve({ fetch: createApp().fetch, hostname: '127.0.0.1', port: config.port }, ({ port }) => {
  console.log(`Podcast Generator bezi na http://localhost:${port}`);
});
