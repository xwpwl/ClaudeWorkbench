import { describe, it, expect } from 'vitest';
import { sanitizeLog, containsSensitiveData } from '../Sanitizer';

describe('sanitizeLog', () => {
  it('should redact API keys', () => {
    const input = 'Using key: sk-ant-abc123def456ghi789jkl012mno345';
    const result = sanitizeLog(input);
    expect(result).not.toContain('sk-ant-abc123');
    expect(result).toContain('[REDACTED_API_KEY]');
  });

  it('should redact Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = sanitizeLog(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('[REDACTED_TOKEN]');
  });

  it('should redact Authorization headers', () => {
    const input = 'Authorization: Basic dXNlcjpwYXNz';
    const result = sanitizeLog(input);
    expect(result).not.toContain('dXNlcjpwYXNz');
  });

  it('should redact ANTHROPIC_API_KEY', () => {
    const input = 'ANTHROPIC_API_KEY=sk-ant-secret123456789';
    const result = sanitizeLog(input);
    expect(result).not.toContain('sk-ant-secret');
    expect(result).toContain('REDACTED');
  });

  it('should redact ANTHROPIC_AUTH_TOKEN', () => {
    const input = 'ANTHROPIC_AUTH_TOKEN=my-secret-token-value';
    const result = sanitizeLog(input);
    expect(result).not.toContain('my-secret-token-value');
  });

  it('should redact generic tokens', () => {
    const input = 'token=supersecretvalue123456';
    const result = sanitizeLog(input);
    expect(result).not.toContain('supersecretvalue123456');
  });

  it('should redact passwords', () => {
    const input = 'password: mysecretpassword123';
    const result = sanitizeLog(input);
    expect(result).not.toContain('mysecretpassword123');
  });

  it('should not redact normal text', () => {
    const input = 'This is a normal log message about code changes.';
    const result = sanitizeLog(input);
    expect(result).toBe(input);
  });

  it('should not redact short strings', () => {
    const input = 'token=abc';
    const result = sanitizeLog(input);
    expect(result).toBe(input);
  });

  it('should handle multiple sensitive items', () => {
    const input =
      'Key: sk-ant-abc123def456ghi789jkl012mno345 and token: Bearer eyJhbGciOiJIUzI1NiJ9';
    const result = sanitizeLog(input);
    expect(result).not.toContain('sk-ant-abc123');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('containsSensitiveData', () => {
  it('should detect API keys', () => {
    expect(containsSensitiveData('sk-ant-abc123def456ghi789jkl012mno345')).toBe(true);
  });

  it('should detect Bearer tokens', () => {
    expect(
      containsSensitiveData(
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      ),
    ).toBe(true);
  });

  it('should not flag normal text', () => {
    expect(containsSensitiveData('Hello world')).toBe(false);
  });

  it('should detect ANTHROPIC_API_KEY', () => {
    expect(containsSensitiveData('ANTHROPIC_API_KEY=secret')).toBe(true);
  });
});
