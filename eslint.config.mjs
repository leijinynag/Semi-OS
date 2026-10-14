import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/.vite/**",
      "**/generated/**",
      "docs/assets/**",
      "tmp/**",
    ],
  },
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  })),
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
      },
    },
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      // TypeScript 编译器负责类型正确性；ESLint 负责语法和可维护性门禁。
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-this-alias": "off",
      "prefer-const": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  {
    files: ["apps/desktop/src/voice/pcm-worklet.js"],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
      },
    },
  },
];
