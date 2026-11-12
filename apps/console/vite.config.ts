import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The console talks to the gateway on this machine. Requests go through the dev server, so the browser
// only ever speaks to one origin and the gateway needs no cross-origin rules.
const gateway = `http://127.0.0.1:${process.env.GATEWAY_PORT ?? '8787'}`;

// The vault the console is for. Like the port it comes from the shell, not from the gateway: the
// console checks what the gateway says against this address. Empty means the vault this repository
// records as deployed.
const vault = process.env.VITE_VAULT_ADDRESS ?? process.env.MANDATE_VAULT_ADDRESS ?? '';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_VAULT_ADDRESS': JSON.stringify(vault) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/v1': gateway, '/healthz': gateway },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/v1': gateway, '/healthz': gateway },
  },
});
