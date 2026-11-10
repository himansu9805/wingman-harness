// Production installs may omit dev dependencies; CI enforces checks directly.
if (process.env.NODE_ENV !== "production" && process.env.CI !== "true") {
  const { default: husky } = await import("husky");
  const message = husky();
  if (message) console.log(message);
}
