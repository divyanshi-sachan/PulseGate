import { describe, expect, it } from 'vitest';
import { GATEWAY_ERRORS, GatewayError, isGatewayError, type GatewayErrorCode } from './index.ts';

describe('GATEWAY_ERRORS', () => {
  it('maps every code to the status recorded in ADR-0018', () => {
    const expected: Record<GatewayErrorCode, number> = {
      BAD_REQUEST: 400,
      AUTHENTICATION_FAILED: 401,
      ADMIN_AUTHENTICATION_FAILED: 401,
      ROUTE_NOT_FOUND: 404,
      METHOD_NOT_ALLOWED: 405,
      PAYLOAD_TOO_LARGE: 413,
      RATE_LIMIT_EXCEEDED: 429,
      INTERNAL_ERROR: 500,
      UPSTREAM_UNAVAILABLE: 502,
      UPSTREAM_RESPONSE_TOO_LARGE: 502,
      CIRCUIT_OPEN: 503,
      UPSTREAM_TIMEOUT: 504,
    };
    const actual = Object.fromEntries(
      Object.entries(GATEWAY_ERRORS).map(([code, { status }]) => [code, status]),
    );
    expect(actual).toEqual(expected);
  });
});

describe('GatewayError', () => {
  it('serializes to the normalized body with the default message', () => {
    const error = new GatewayError('RATE_LIMIT_EXCEEDED');
    expect(error.status).toBe(429);
    expect(error.toBody('req_example')).toEqual({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Request limit exceeded',
        requestId: 'req_example',
      },
    });
  });

  it('uses a client-safe override message when given', () => {
    const error = new GatewayError('BAD_REQUEST', {
      publicMessage: 'Protocol upgrade not supported',
    });
    expect(error.toBody('req_1').error.message).toBe('Protocol upgrade not supported');
  });

  it('keeps internal causes out of the client body', () => {
    const cause = new Error('ECONNREFUSED 10.0.0.5:4001');
    const error = new GatewayError('UPSTREAM_UNAVAILABLE', { cause });
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toBody('req_2'))).not.toContain('ECONNREFUSED');
  });

  it('is recognized by isGatewayError', () => {
    expect(isGatewayError(new GatewayError('INTERNAL_ERROR'))).toBe(true);
    expect(isGatewayError(new Error('plain'))).toBe(false);
  });
});
