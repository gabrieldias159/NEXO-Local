import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // youtubei.js usa APIs do Node que não sobrevivem ao bundle do webpack.
  // Mantê-lo como externo faz o runtime importar direto dos node_modules.
  // Usado pelo fallback de import de vídeo por URL (`/api/video/import-url`).
  serverExternalPackages: ['youtubei.js'],

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
      {
        // Assets do Next: precisam declarar COEP porque o WORKER do FFmpeg.wasm
        // e carregado de /_next/static/chunks/. Num documento com COEP, um
        // Worker so instancia se a RESPOSTA do script dele tambem trouxer o
        // header — senao o browser barra com
        // ERR_BLOCKED_BY_RESPONSE e o render local morre com "Erro no worker".
        // CORP same-origin cobre os demais assets sob a mesma politica.
        // Declarar COEP num asset NAO isola quem o consome: paginas fora do
        // estudio seguem sem isolamento e com os popups de auth funcionando.
        source: '/_next/:path*',
        headers: [
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
      {
        // Headers COOP/COEP escopados ao Estúdio de Vídeo (avançado).
        // Necessário para SharedArrayBuffer (FFmpeg.wasm multi-thread + WebCodecs).
        // NÃO aplicar globalmente — quebra popups de auth do Firebase.
        //
        // `credentialless`, NÃO `require-corp`: aqui tudo roda contra os
        // EMULADORES, e o Firestore emulado vive em outra origem
        // (127.0.0.1:8080 vs localhost:9002) sem mandar `Cross-Origin-Resource-Policy`.
        // Sob `require-corp` o transporte WebChannel do SDK (que carrega via
        // <script>, portanto no-cors) era barrado com
        // ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep
        // e NENHUMA leitura/escrita de projeto funcionava. `credentialless`
        // mantém o cross-origin isolation exigido pelo SharedArrayBuffer, mas
        // dispensa o CORP em requisição no-cors (envia sem credencial — o que
        // é irrelevante para o emulador local). Mesmo valor já usado no básico.
        source: '/apps/suite-editor-videos/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
        ],
      },
      {
        // Estúdio básico também usa FFmpeg.wasm — precisa de cross-origin isolation.
        // credentialless permite carregar assets de CDN sem CORP header.
        source: '/apps/editor-videos/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
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

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'placehold.co', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'images.unsplash.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'picsum.photos', port: '', pathname: '/**' },
      {
        protocol: 'https',
        hostname: 'upload.wikimedia.org',
        port: '',
        pathname: '/wikipedia/commons/**',
      },
      { protocol: 'https', hostname: 'storage.googleapis.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'firebasestorage.googleapis.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com', port: '', pathname: '/**' },
    ],
  },
};

export default nextConfig;
