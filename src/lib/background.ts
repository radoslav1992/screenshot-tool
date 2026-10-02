/**
 * Runs work after the response has gone, when the runtime allows it, and
 * inline otherwise. For mail: nobody should wait on a mail provider to finish
 * signing up, and a reset request should take as long whether or not there was
 * an account to email.
 *
 * `work` must handle its own errors; nothing is left to report them to.
 */
export async function afterResponse(locals: App.Locals, work: Promise<unknown>): Promise<void> {
  const context = (locals as Partial<App.Locals>).cfContext;
  if (typeof context?.waitUntil === 'function') {
    context.waitUntil(work);
    return;
  }
  await work;
}
