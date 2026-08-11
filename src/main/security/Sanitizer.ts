/**
 * Sanitizes sensitive information from log output.
 * Redacts API keys, tokens, authorization headers, cookies, and sensitive config values.
 */
export function sanitizeLog(input: string): string {
  let result = input;

  // API keys (various formats)
  result = result.replace(
    /(?:sk-ant-|sk-|ak-|api[_-]?key[=:\s]+)['"]?[A-Za-z0-9_-]{20,}['"]?/gi,
    '[REDACTED_API_KEY]',
  );

  // Bearer tokens
  result = result.replace(
    /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
    'Bearer [REDACTED_TOKEN]',
  );

  // Authorization headers (including Basic auth with shorter tokens)
  result = result.replace(
    /Authorization[=:\s]+(?:Basic\s+|Bearer\s+)?['"]?[A-Za-z0-9._-]{8,}['"]?/gi,
    'Authorization: [REDACTED]',
  );

  // Cookie headers
  result = result.replace(
    /Cookie[=:\s]+['"]?[^'";\n]{20,}['"]?/gi,
    'Cookie: [REDACTED]',
  );

  // Anthropic specific keys
  result = result.replace(
    /ANTHROPIC_API_KEY[=:\s]+['"]?[A-Za-z0-9_-]+['"]?/gi,
    'ANTHROPIC_API_KEY=[REDACTED]',
  );

  result = result.replace(
    /ANTHROPIC_AUTH_TOKEN[=:\s]+['"]?[A-Za-z0-9._-]+['"]?/gi,
    'ANTHROPIC_AUTH_TOKEN=[REDACTED]',
  );

  result = result.replace(
    /ANTHROPIC_BASE_URL[=:\s]+['"]?https?:\/\/[^\s'"]+['"]?/gi,
    'ANTHROPIC_BASE_URL=[REDACTED]',
  );

  // Generic token patterns
  result = result.replace(
    /(?:token|secret|password|passwd)[=:\s]+['"]?[A-Za-z0-9._-]{8,}['"]?/gi,
    (match) => {
      const prefix = match.split(/[=:\s]/)[0];
      return `${prefix}=[REDACTED]`;
    },
  );

  // User home directory paths (privacy)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (homeDir) {
    result = result.replace(
      new RegExp(escapeRegex(homeDir), 'gi'),
      '~',
    );
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks if a string looks like it contains sensitive data.
 */
export function containsSensitiveData(input: string): boolean {
  const patterns = [
    /sk-ant-[A-Za-z0-9_-]{20,}/,
    /sk-[A-Za-z0-9_-]{20,}/,
    /Bearer\s+[A-Za-z0-9._-]{20,}/i,
    /Authorization[=:\s]+['"]?[A-Za-z0-9._-]{20,}/i,
    /ANTHROPIC_API_KEY[=:\s]+/i,
    /ANTHROPIC_AUTH_TOKEN[=:\s]+/i,
  ];

  return patterns.some((p) => p.test(input));
}
