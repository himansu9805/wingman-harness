/** An inert sandbox executor for tests that exercise agent composition. */
export const sandboxExecutor = {
  target: "sandbox",
  async executeShell() {
    return { stdout: "", stderr: "", exit_code: 0 };
  },
};
