import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// `npm run dev:https` serve o cliente com um certificado auto-assinado, para
// testar a geolocalização num telemóvel da mesma rede (o browser exige HTTPS).
const https = process.env.HTTPS === '1';
const backend = process.env.BACKEND_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [
    react(),
    ...(https ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'FindMe',
        short_name: 'FindMe',
        description: 'Partilha a localização em tempo real com um amigo e vejam o caminho de cada um.',
        lang: 'pt-PT',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // A API e o tempo real nunca passam pela cache do service worker.
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
});
