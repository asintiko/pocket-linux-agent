import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { ModelInfo } from '@pocket/protocol';

/** Model values are namespaced so selecting one also selects the engine, without changing Claude aliases. */
export const KIMI_PREFIX = 'kimi:';
export const isKimiModel = (model: string | undefined): boolean => model?.startsWith(KIMI_PREFIX) ?? false;
export const kimiCliModel = (model: string): string => model.startsWith(KIMI_PREFIX) ? model.slice(KIMI_PREFIX.length) : model;

const KIMI_THINKING = ['low', 'high', 'max'] as const;

export const KIMI_FALLBACK_MODELS: ModelInfo[] = [
  { value: `${KIMI_PREFIX}kimi-code/kimi-for-coding`, displayName: 'K2.8 Preview', description: 'Kimi Code CLI · coding model', efforts: [...KIMI_THINKING] },
  { value: `${KIMI_PREFIX}kimi-code/kimi-for-coding-highspeed`, displayName: 'K2.7 Code Highspeed', description: 'Kimi Code CLI · high-speed coding model' },
  { value: `${KIMI_PREFIX}kimi-code/k3`, displayName: 'K3', description: 'Kimi Code CLI · K3', efforts: [...KIMI_THINKING] },
  { value: `${KIMI_PREFIX}kimi-code/k3-256k`, displayName: 'K3-256k', description: 'Kimi Code CLI · K3, 256k context', efforts: [...KIMI_THINKING] },
  { value: `${KIMI_PREFIX}kimi-code/k3.1-pro`, displayName: 'K3.1 Pro', description: 'Kimi Code CLI · K3.1 Pro', efforts: [...KIMI_THINKING] },
  { value: `${KIMI_PREFIX}kimi-code/k3.1-pro-highspeed`, displayName: 'K3.1 Pro Highspeed 2x Usage Cost', description: 'Kimi Code CLI · K3.1 Pro high speed', efforts: [...KIMI_THINKING] },
];

const KIMI_MODEL_DETAILS = new Map(KIMI_FALLBACK_MODELS.map((model) => [model.value, model]));

function selectOptions(option: SessionConfigOption): { value: string; name: string; description?: string | null }[] {
  if (option.type !== 'select') return [];
  const groups = option.options;
  if (!groups.length) return [];
  return groups.flatMap((item) => 'options' in item ? item.options : [item]);
}

/** Converts the model selector advertised by Kimi ACP into the phone's common Claude + Kimi catalog. */
export function kimiModelsFromConfig(options: readonly SessionConfigOption[] | null | undefined): ModelInfo[] {
  const selector = options?.find((option) => option.category === 'model' || option.id === 'model');
  if (!selector) return [];
  return selectOptions(selector).map((model) => {
    const value = `${KIMI_PREFIX}${model.value}`;
    const known = KIMI_MODEL_DETAILS.get(value);
    return {
      value,
      displayName: model.name || known?.displayName || value,
      description: model.description ?? known?.description ?? 'Kimi Code CLI model',
      ...(known?.efforts ? { efforts: [...known.efforts] } : {}),
    };
  });
}

export function withKimi(models: readonly ModelInfo[], kimiModels: readonly ModelInfo[] = KIMI_FALLBACK_MODELS): ModelInfo[] {
  return [...models.filter((model) => !isKimiModel(model.value)), ...(kimiModels.length ? kimiModels : KIMI_FALLBACK_MODELS)];
}
