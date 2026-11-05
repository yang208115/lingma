import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const host = env.HOST || '127.0.0.1';
  const proxyHost = host.includes(':') ? `[${host}]` : host;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://${proxyHost}:${env.PORT || '3000'}`,
          changeOrigin: true,
        },
      },
    },
  };
});
