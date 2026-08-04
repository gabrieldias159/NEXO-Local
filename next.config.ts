import type { NextConfig } from 'next';

// Config enxuta pro NEXO-Local — sem os headers COOP/COEP do editor de vídeo
// e sem `serverExternalPackages` (youtubei.js), que eram do oficioexpress e
// não se aplicam aqui.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Permite que o pop-up de autenticação do Google/Firebase funcione.
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
        ],
      },
    ];
  },

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },

  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
