import { HttpError } from './http';

/**
 * Turns an unknown thrown value into an HttpError, logging anything we did not
 * raise deliberately so it shows up in `wrangler tail` and Workers observability.
 *
 * Some infrastructure failures are worth naming explicitly: a deployment whose
 * D1 schema was never applied fails on every write, and "something went wrong"
 * sends people looking in the wrong place.
 */
export function toHttpError(error: unknown, context: string, fallback: string): HttpError {
  if (error instanceof HttpError) return error;

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${context}] ${message}`, error instanceof Error ? error.stack : undefined);

  // D1 reports a missing table as "no such table: users".
  if (/no such table/i.test(message)) {
    return new HttpError(
      503,
      'schema_missing',
      'The database schema has not been applied yet. Run `npm run db:migrate`, or paste db/apply-manually.sql into the D1 console.',
    );
  }

  // D1 reports a schema that predates a migration as "no such column: …".
  if (/no such column/i.test(message)) {
    return new HttpError(
      503,
      'schema_outdated',
      'The database schema is out of date. Apply the pending migrations with `npm run db:migrate`.',
    );
  }

  if (/D1_ERROR|Network connection lost|storage operation/i.test(message)) {
    return new HttpError(503, 'database_unavailable', 'The database is temporarily unavailable. Try again.');
  }

  return new HttpError(500, 'server_error', fallback);
}
