import globals from "globals";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "output/**",
      "public/**",
      "tmp/**"
    ]
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    // Size warning for app and library code so large files are noticed before they grow further.
    files: ["app/**/*.js", "lib/**/*.js"],
    rules: {
      "max-lines": ["warn", { max: 1000 }]
    }
  }
];
