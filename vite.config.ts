import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': 'http://127.0.0.1:5175' } },
  preview: { host: '0.0.0.0', port: 4173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/katex/') || id.includes('/rehype-katex/') || id.includes('/remark-math/')) return 'math';
          if (id.includes('/echarts/') || id.includes('/zrender/')) return 'charts';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react-vendor';
          if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/micromark') || id.includes('/mdast-') || id.includes('/hast-') || id.includes('/unist-')) return 'markdown';
        },
      },
    },
  },
});
