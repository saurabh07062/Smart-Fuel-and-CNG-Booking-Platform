/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // The Vanilla app's design tokens are CSS custom properties in
      // css/variables.css. Exposing them to Tailwind here means a utility
      // like `bg-primary` resolves to the SAME value the old stylesheet
      // used, so the migrated UI cannot drift from the original.
      colors: {
        primary: "var(--primary)",
        "primary-light": "var(--primary-light)",
        secondary: "var(--secondary)",
        accent: "var(--accent)",
        danger: "var(--danger)",
        card: "var(--card)",
        muted: "var(--muted)",
      },
      fontFamily: {
        display: ['"Space Grotesk"', "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
