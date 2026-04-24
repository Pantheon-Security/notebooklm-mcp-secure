export type MetricLabels = Record<string, string | number | boolean>;

export interface MetricSample {
  name: string;
  value: number;
  labels: MetricLabels;
}

function labelsKey(labels: MetricLabels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

export class MetricsRegistry {
  private counters = new Map<string, MetricSample>();
  private gauges = new Map<string, MetricSample>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = `${name}:${labelsKey(labels)}`;
    const existing = this.counters.get(key);
    this.counters.set(key, {
      name,
      labels,
      value: (existing?.value ?? 0) + value,
    });
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = `${name}:${labelsKey(labels)}`;
    this.gauges.set(key, { name, labels, value });
  }

  snapshot(): { counters: MetricSample[]; gauges: MetricSample[] } {
    return {
      counters: Array.from(this.counters.values()),
      gauges: Array.from(this.gauges.values()),
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

const metrics = new MetricsRegistry();

export function getMetricsRegistry(): MetricsRegistry {
  return metrics;
}
