import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#14181F",
        "ink-soft": "#4A5462",
        "ink-faint": "#8B94A3",
        paper: "#FCFCFB",
        surface: "#FFFFFF",
        rule: "#E3E6EA",
        "rule-firm": "#C9CFD6",
        flag: "#8B3A2F",
        "flag-bg": "#FBF2F0",
        hold: "#6B5B2E",
        "hold-bg": "#FAF6EC",
        ok: "#2F5D4F",
      },
      maxWidth: {
        audit: "1200px",
        prose: "68ch",
      },
      fontSize: {
        xs: ["12px", "18px"],
        sm: ["13px", "20px"],
        base: ["15px", "24px"],
        lg: ["18px", "26px"],
        xl: ["24px", "32px"],
        "2xl": ["32px", "40px"],
        "3xl": ["48px", "52px"],
      },
      boxShadow: {
        focus: "0 0 0 3px rgba(139, 58, 47, 0.24)",
      },
    },
  },
  plugins: [],
};

export default config;
