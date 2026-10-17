export {};
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? 3000}/api/client-settings`,
    {
      signal: AbortSignal.timeout(4000),
    },
  );
  await response.arrayBuffer();
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
