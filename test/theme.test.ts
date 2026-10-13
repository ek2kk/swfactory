import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme, readTheme } from '../src/client/theme.js';

test('theme restores explicit choices and falls back to system for missing, invalid or blocked storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const [saved, expected] of [[null, 'system'], ['system', 'system'], ['invalid', 'system'], ['light', 'light'], ['dark', 'dark']]) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => saved } });
      assert.equal(readTheme(), expected);
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    assert.equal(readTheme(), 'system');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('explicit theme overrides are removed when returning to system', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  try {
    applyTheme('dark');
    assert.equal(dataset.theme, 'dark');
    applyTheme('light');
    assert.equal(dataset.theme, 'light');
    applyTheme('system');
    assert.equal(dataset.theme, undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('both palettes keep text, links, disabled controls and focus readable', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  const luminance = (hex: string) => {
    const channels = hex.match(/\w\w/g)!.map(channel => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const palettes = [...css.matchAll(/\{\s*color-scheme: (light|dark);([^}]+)\}/g)];
  assert.equal(palettes.length, 3);
  assert.equal(palettes[1][2].trim(), palettes[2][2].trim(), 'system and explicit dark palettes match');
  for (const [, theme, body] of palettes) {
    const colors = Object.fromEntries([...body.matchAll(/--([\w-]+): #([\da-f]{6})/g)].map(([, name, hex]) => [name, luminance(hex)]));
    const contrast = (a: string, b: string) => (Math.max(colors[a], colors[b]) + 0.05) / (Math.min(colors[a], colors[b]) + 0.05);
    for (const background of ['background', 'surface', 'column', 'human']) {
      for (const text of ['text', 'muted', 'accent-text', 'link']) {
        assert.ok(contrast(text, background) >= 4.5, `${theme}: ${text} on ${background}`);
      }
      assert.ok(contrast('focus', background) >= 3, `${theme}: focus on ${background}`);
    }
    for (const [text, background] of [['primary-text', 'primary'], ['error-text', 'error-background'], ['muted', 'disabled-background']]) {
      assert.ok(contrast(text, background) >= 4.5, `${theme}: ${text} on ${background}`);
    }
  }
});
