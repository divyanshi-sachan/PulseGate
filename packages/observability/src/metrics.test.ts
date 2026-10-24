import { describe, expect, it } from 'vitest';
import { GatewayMetrics } from './index.ts';

describe('GatewayMetrics label bounds (ADR-0036)', () => {
  it('maps unknown routes, upstreams and codes onto fixed values', async () => {
    const metrics = new GatewayMetrics({
      routes: ['orders'],
      upstreams: ['orders-service'],
      defaultMetrics: false,
    });
    metrics.requestCompleted({
      routeId: '/api/orders/123',
      statusCode: 200,
      code: undefined,
      durationSeconds: 0.01,
    });
    metrics.requestCompleted({
      routeId: 'orders',
      statusCode: 799,
      code: 'SOMETHING_NEW',
      durationSeconds: 0.01,
    });
    metrics.upstreamAttempt('10.0.0.5:4001', 'success', 0.01);
    metrics.cacheLookup('req_123', 'hit');
    const text = await metrics.text();
    expect(text).toContain(
      'pulsegate_requests_total{route="unmatched",status_class="2xx",code="none"} 1',
    );
    expect(text).toContain(
      'pulsegate_requests_total{route="orders",status_class="unknown",code="other"} 1',
    );
    expect(text).toContain(
      'pulsegate_upstream_requests_total{upstream="unknown",outcome="success"} 1',
    );
    expect(text).toContain('pulsegate_cache_requests_total{route="unmatched",result="hit"} 1');
    expect(text).not.toMatch(/\/api\/orders\/123|10\.0\.0\.5|req_123|SOMETHING_NEW/);
  });

  it('keeps exactly one breaker state at 1 per upstream', async () => {
    const metrics = new GatewayMetrics({ routes: [], upstreams: ['a'], defaultMetrics: false });
    metrics.breakerTransition('a', 'closed', 'open');
    metrics.breakerTransition('a', 'open', 'half-open');
    const text = await metrics.text();
    expect(text).toContain('pulsegate_circuit_breaker_state{upstream="a",state="half-open"} 1');
    expect(text).toContain('pulsegate_circuit_breaker_state{upstream="a",state="open"} 0');
    expect(text).toContain('pulsegate_circuit_breaker_state{upstream="a",state="closed"} 0');
  });
});
