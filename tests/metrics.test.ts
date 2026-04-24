import { describe, it, expect, beforeEach } from "vitest";
import { getMetricsRegistry } from "../src/observability/metrics.js";

describe("metrics registry", () => {
  beforeEach(() => {
    getMetricsRegistry().reset();
  });

  it("tracks counters and gauges with labels", () => {
    const metrics = getMetricsRegistry();

    metrics.increment("webhook_deliveries_total", { success: true });
    metrics.increment("webhook_deliveries_total", { success: true });
    metrics.increment("webhook_deliveries_total", { success: false });
    metrics.setGauge("quota_queries_percent", 80, { tier: "free" });

    expect(metrics.snapshot().counters).toEqual(
      expect.arrayContaining([
        { name: "webhook_deliveries_total", labels: { success: true }, value: 2 },
        { name: "webhook_deliveries_total", labels: { success: false }, value: 1 },
      ])
    );
    expect(metrics.snapshot().gauges).toEqual([
      { name: "quota_queries_percent", labels: { tier: "free" }, value: 80 },
    ]);
  });
});
