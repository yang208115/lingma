import type { Usage } from '@lingma/shared';
import { AgentError } from './errors.js';

const parts = (value: string) => {
  if (!/^\d+(\.\d+)?$/.test(value) || value.length > 512)
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  const [whole = '0', fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
};
const render = (units: bigint, scale: number) => {
  const text = units.toString().padStart(scale + 1, '0');
  return scale
    ? `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, '') || '0'
    : text;
};
export function addDecimal(a: string, b: string): string {
  const x = parts(a);
  const y = parts(b);
  const scale = Math.max(x.scale, y.scale);
  return render(
    x.units * 10n ** BigInt(scale - x.scale) + y.units * 10n ** BigInt(scale - y.scale),
    scale,
  );
}
export function priceTokens(tokens: number, perMillion: string): string {
  const rate = parts(perMillion);
  return render(rate.units * BigInt(tokens), rate.scale + 6);
}
export interface UsageSummary {
  known: Usage;
  complete: boolean;
  inputComplete: boolean;
  outputComplete: boolean;
  costComplete: boolean;
  calls: number;
  byCurrency: {
    currency: string;
    amount: string;
    source: 'provider' | 'estimate';
    mixedSources: boolean;
  }[];
}
export class UsageAccumulator {
  private readonly values: (Usage | null)[] = [];
  begin(): number {
    this.values.push(null);
    return this.values.length - 1;
  }
  set(index: number, usage: Usage): void {
    if (usage.cost) {
      if (usage.cost.amount.length > 256) throw new AgentError('MODEL_PROTOCOL_ERROR');
      parts(usage.cost.amount);
    }
    this.values[index] = structuredClone(usage);
  }
  summary(): UsageSummary {
    let input: number | null = null;
    let output: number | null = null;
    let inputComplete = this.values.length > 0;
    let outputComplete = inputComplete;
    let costComplete = inputComplete;
    const currencies = new Map<string, UsageSummary['byCurrency'][number]>();
    for (const usage of this.values) {
      if (usage?.inputTokens == null) inputComplete = false;
      else input = (input ?? 0) + usage.inputTokens;
      if (usage?.outputTokens == null) outputComplete = false;
      else output = (output ?? 0) + usage.outputTokens;
      if (!usage?.cost) costComplete = false;
      else {
        const cost = usage.cost;
        const previous = currencies.get(cost.currency);
        currencies.set(cost.currency, {
          currency: cost.currency,
          amount: addDecimal(previous?.amount ?? '0', cost.amount),
          source:
            previous?.source === 'estimate' || cost.source === 'estimate' ? 'estimate' : 'provider',
          mixedSources: Boolean(
            previous?.mixedSources || (previous && previous.source !== cost.source),
          ),
        });
      }
    }
    if (input !== null && !Number.isSafeInteger(input)) {
      input = null;
      inputComplete = false;
    }
    if (output !== null && !Number.isSafeInteger(output)) {
      output = null;
      outputComplete = false;
    }
    const byCurrency = [...currencies.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );
    const only = byCurrency.length === 1 ? byCurrency[0] : undefined;
    return {
      known: {
        inputTokens: input,
        outputTokens: output,
        cost: only ? { amount: only.amount, currency: only.currency, source: only.source } : null,
      },
      complete: inputComplete && outputComplete && costComplete && byCurrency.length === 1,
      inputComplete,
      outputComplete,
      costComplete,
      calls: this.values.length,
      byCurrency,
    };
  }
}
