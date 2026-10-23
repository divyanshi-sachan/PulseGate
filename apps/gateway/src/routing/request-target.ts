import { GatewayError } from '@pulsegate/shared';

export interface RequestTarget {
  /** Raw, undecoded path exactly as received (ADR-0019). */
  rawPath: string;
  /** Raw query without the leading "?"; empty when absent or bare. */
  rawQuery: string;
}

const VALID_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;

function badRequest(publicMessage: string): GatewayError {
  return new GatewayError('BAD_REQUEST', { publicMessage });
}

/**
 * Splits and validates the raw request target before route matching (ADR-0019 steps 1-3).
 * Nothing is decoded or normalized; unsafe input is rejected with 400 BAD_REQUEST.
 */
export function parseRequestTarget(rawUrl: string): RequestTarget {
  const queryStart = rawUrl.indexOf('?');
  const rawPath = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : rawUrl.slice(queryStart + 1);

  if (!rawPath.startsWith('/')) {
    throw badRequest('Request target must be an origin-form path starting with "/"');
  }
  if (rawPath.includes('\\')) {
    throw badRequest('Request path must not contain "\\"');
  }
  if (VALID_PERCENT_ENCODING.test(rawPath) || VALID_PERCENT_ENCODING.test(rawQuery)) {
    throw badRequest('Request target contains invalid percent-encoding');
  }
  for (const segment of rawPath.split('/')) {
    const decodedDots = segment.replace(/%2e/gi, '.');
    if (decodedDots === '.' || decodedDots === '..') {
      throw badRequest('Request path must not contain "." or ".." segments');
    }
  }
  return { rawPath, rawQuery };
}
