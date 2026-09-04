import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Dark, high-density broadcast-style theme (Req 15.1, 15.2).
 * Colors are exposed as CSS variables in src/index.css so Shadcn UI
 * components resolve against the same palette.
 */
const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1440px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // RAG status accents — high-contrast, never color-only in the UI (Req 15.1).
        rag: {
          green: "hsl(var(--rag-green))",
          amber: "hsl(var(--rag-amber))",
          red: "hsl(var(--rag-red))",
          neutral: "hsl(var(--rag-neutral))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontSize: {
        // Compact scale for high-density tables/scorecards (Req 15.2).
        "2xs": ["0.6875rem", { lineHeight: "0.875rem" }],
      },
    },
  },
  plugins: [animate],
};

// eslint-disable-next-line import/no-default-export
export { config as default };
