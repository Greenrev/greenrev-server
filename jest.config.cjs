module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
      },
    ],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  // These are integration tests: each file starts its own MongoDB and drives the real app.
  // Too many at once on a laptop causes timeouts, so cap parallelism and allow more time.
  maxWorkers: 2,
  testTimeout: 30_000,
};
