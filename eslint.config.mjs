import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextVitals,
  {
    ignores: [
      ".next/**",
      "data/**",
      "desktop/generated/**",
      "dist/**",
      "experiments/**",
      "node_modules/**",
      "opencut/**",
      "opencut-classic/**",
    ],
  },
  {
    // This React 19 advisory was promoted to an error by the upstream preset.
    // Existing first-party effects intentionally synchronize async/UI state;
    // keep them visible without making an otherwise valid release unbuildable.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
