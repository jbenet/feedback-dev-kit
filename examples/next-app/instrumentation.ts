/** Next calls this once per server process: start the ingester, so whatever a restart left in the journal is filed. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { feedback } = await import('./lib/feedback');
  feedback();
}
