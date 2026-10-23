/**
 * Normalized gateway error registry (ADR-0011, extended by ADR-0017, 0018, 0020, 0023, 0024).
 * Every gateway-generated error response uses one of these codes and the JSON shape in {@link GatewayErrorBody}.
 */
export const GATEWAY_ERRORS = {
  BAD_REQUEST: { status: 400, message: 'Bad request' },
  AUTHENTICATION_FAILED: { status: 401, message: 'Authentication failed' },
  ADMIN_AUTHENTICATION_FAILED: { status: 401, message: 'Admin authentication failed' },
  ROUTE_NOT_FOUND: { status: 404, message: 'Route not found' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request payload too large' },
  RATE_LIMIT_EXCEEDED: { status: 429, message: 'Request limit exceeded' },
  INTERNAL_ERROR: { status: 500, message: 'Internal gateway error' },
  UPSTREAM_UNAVAILABLE: { status: 502, message: 'Upstream unavailable' },
  UPSTREAM_RESPONSE_TOO_LARGE: { status: 502, message: 'Upstream response too large' },
  CIRCUIT_OPEN: { status: 503, message: 'Upstream temporarily unavailable' },
  UPSTREAM_TIMEOUT: { status: 504, message: 'Upstream timed out' },
} as const satisfies Record<string, { status: number; message: string }>;

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

export interface GatewayErrorBody {
  error: {
    code: GatewayErrorCode;
    message: string;
    requestId: string;
  };
}

export interface GatewayErrorOptions {
  /** Client-safe message replacing the default for this code. Never put internal details here. */
  publicMessage?: string;
  /** Internal diagnostics for structured logs; never serialized to clients. */
  cause?: unknown;
}

export class GatewayError extends Error {
  override readonly name = 'GatewayError';
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly publicMessage: string;

  constructor(code: GatewayErrorCode, options: GatewayErrorOptions = {}) {
    const publicMessage = options.publicMessage ?? GATEWAY_ERRORS[code].message;
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = GATEWAY_ERRORS[code].status;
    this.publicMessage = publicMessage;
  }

  toBody(requestId: string): GatewayErrorBody {
    return { error: { code: this.code, message: this.publicMessage, requestId } };
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}
