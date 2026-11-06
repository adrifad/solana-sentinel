import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
