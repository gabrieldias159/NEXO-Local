import type {Config} from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // MOVIMENTO do editor.
      //
      // Os tokens ja existiam em globals.css, mas eram usados como
      // `duration-[var(--editor-motion-fast)]` — forma AMBIGUA no Tailwind 3
      // (casa transition-duration E animation-duration), e o build descartava
      // a classe. Resultado: as transicoes simplesmente nao rodavam. Registrar
      // aqui torna `duration-fast` / `ease-editor` inequivocos, mantendo o
      // valor no CSS var (um lugar so para ajustar o ritmo da interface).
      transitionDuration: {
        instant: 'var(--editor-motion-instant)',
        fast: 'var(--editor-motion-fast)',
        base: 'var(--editor-motion-base)',
        slow: 'var(--editor-motion-slow)',
        snap: 'var(--editor-motion-snap)',
      },
      transitionTimingFunction: {
        editor: 'var(--editor-ease-out)',
        'editor-in-out': 'var(--editor-ease-in-out)',
      },
      fontFamily: {
        // var(--font-*) vem do next/font (self-hosted); literais ficam de
        // fallback p/ contextos sem as variáveis (ex.: print/portais antigos).
        body: ['var(--font-inter)', 'Inter', 'sans-serif'],
        headline: ['var(--font-inter)', 'Inter', 'sans-serif'],
        poppins: ['var(--font-poppins)', 'Poppins', 'sans-serif'],
        code: ['monospace'],
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
        // NEXO — a sala de situação tem tema escuro PRÓPRIO (fora do sistema
        // HSL claro do app). Os 4 "pretos" não competem: são CAMADAS. Tokenizados
        // aqui para os literais hex saírem das 39 páginas (ver plano reforma).
        nexo: {
          bg: '#070809', // fundo do shell (atrás de tudo)
          chrome: '#0c0e13', // sidebar, header, inputs, controles, thead
          surface: '#0f1218', // cards/painéis de conteúdo (superfície de leitura)
          inset: '#0a0b0f', // poços internos: linhas de tabela, células KPI
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
        'ia-glow': {
          '0%': { 'background-size':'200% 200%', 'background-position': 'left center' },
          '50%': { 'background-size':'200% 200%', 'background-position': 'right center' },
          '100%': { 'background-size':'200% 200%', 'background-position': 'left center' }
        },
        'fade-in-up': {
            '0%': {
                opacity: '0',
                transform: 'translateY(20px)'
            },
            '100%': {
                opacity: '1',
                transform: 'translateY(0)'
            }
        },
        'quick-edit-pulse': {
            '0%, 100%': {
                'box-shadow': '0 0 0 0 hsl(var(--primary) / 0.45), 0 0 0 0 hsl(var(--primary) / 0.25)',
                'transform': 'scale(1)'
            },
            '50%': {
                'box-shadow': '0 0 0 6px hsl(var(--primary) / 0.0), 0 0 12px 4px hsl(var(--primary) / 0.35)',
                'transform': 'scale(1.02)'
            }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'ia-glow': 'ia-glow 3s ease infinite',
        'fade-in-up': 'fade-in-up 0.5s ease-out forwards',
        'quick-edit-pulse': 'quick-edit-pulse 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config;
