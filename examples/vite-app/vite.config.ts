import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No proxy: server.ts runs Vite as middleware behind the kit's handler, so the app and /api share one origin.
export default defineConfig({ plugins: [react()] });
