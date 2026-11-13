import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@pocket/protocol';
import { chatConfig, configPatch, effortsFor, fitEffort, modelOptions, patchApplied } from '../src/overlay/config.js';

const MODELS: ModelInfo[] = [
  { value: 'opus', displayName: 'Opus', description: 'Most capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Everyday tasks', efforts: ['low', 'medium', 'high'] },
];

describe('overlay model and thinking choices', () => {
  it('fits a thinking level to what the model has, as the brain does', () => {
    expect(fitEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(fitEffort('medium', ['high', 'max'])).toBe('high');
    expect(fitEffort('low', ['low'])).toBe('low');
    expect(fitEffort('xhigh', [])).toBe('xhigh');
  });

  it('puts "default" first and gives a model the list does not describe every level, as the phone does', () => {
    expect(modelOptions(MODELS).map((m) => m.value)).toEqual(['default', 'opus', 'sonnet']);
    expect(effortsFor('default', MODELS)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor('sonnet', MODELS)).toEqual(['low', 'medium', 'high']);
  });

  it('shows a model the list does not know by its id', () => {
    const config = chatConfig({ model: 'claude-opus-4-1' }, MODELS, false);
    expect(config.model.label).toBe('claude-opus-4-1');
    expect(config.model.options.some((o) => o.selected)).toBe(false);
  });

  it('offers and confirms Ultra on models that advertise it', () => {
    const model = 'codex/gpt-6-astra';
    const models: ModelInfo[] = [...MODELS, { value: model, displayName: 'GPT-6 Astra', description: 'Codex', efforts: ['max', 'ultra'] }];
    const current = { model, codexEffort: 'ultra' as const };
    expect(chatConfig(current, models, false).effort.options.find((option) => option.selected)?.value).toBe('ultra');
    expect(configPatch({ model }, { effort: 'ultra' }, models)).toEqual({ effort: 'ultra' });
    expect(patchApplied(current, { effort: 'ultra' })).toBe(true);
    expect(configPatch({ model: 'sonnet' }, { effort: 'ultra' }, models)).toBeUndefined();
    expect(configPatch(current, { model: 'sonnet' }, models)).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('turns a pick into a patch only when it changes something', () => {
    expect(configPatch({}, { model: 'default' }, MODELS)).toBeUndefined();
    expect(configPatch({}, { effort: 'auto' }, MODELS)).toBeUndefined();
    expect(configPatch({}, { effort: 'bogus' }, MODELS)).toBeUndefined();
    expect(configPatch({ effort: 'max' }, { effort: 'auto' }, MODELS)).toEqual({ effort: null });
    expect(configPatch({ model: 'opus' }, { model: 'default' }, MODELS)).toEqual({ model: null });
    expect(configPatch({ model: 'opus', effort: 'max' }, { model: 'sonnet' }, MODELS)).toEqual({ model: 'sonnet', effort: 'high' });
    expect(configPatch({ model: 'sonnet', effort: 'low' }, { model: 'opus' }, MODELS)).toEqual({ model: 'opus' });
  });
});
