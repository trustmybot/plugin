// The response_format argument read tools share (GH 1958): 'concise' is the
// default and drops heavy columns; 'detailed' returns the full rows.
export const RESPONSE_FORMATS = ['concise', 'detailed'] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

const isResponseFormat = (v: unknown): v is ResponseFormat => (RESPONSE_FORMATS as readonly unknown[]).includes(v);

/** The inputSchema property each read tool declares; `concise` says what that tool's concise form drops. */
export function responseFormatSchema(concise: string): { type: 'string'; enum: string[]; description: string } {
  return {
    type: 'string',
    enum: [...RESPONSE_FORMATS],
    description: `'concise' (default) ${concise}; 'detailed' returns full rows. Ignored when fields is given.`,
  };
}

/** A copy of row without the named keys: the columns a concise row drops. */
export function withoutKeys(row: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

/** Reads args.response_format, defaulting to 'concise'; throws naming the valid values on anything else. */
export function parseResponseFormat(args: Record<string, unknown>): ResponseFormat {
  const value = args['response_format'] ?? 'concise';
  if (!isResponseFormat(value)) {
    throw new Error(`unknown response_format ${JSON.stringify(value)}; valid values: ${RESPONSE_FORMATS.join(', ')}`);
  }
  return value;
}
