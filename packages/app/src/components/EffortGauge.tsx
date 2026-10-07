import React from 'react';
import * as ContextMenu from 'zeego/context-menu';
import { resolveChoice } from '../../../../shared/catalog';
import { useChatStore } from '../state/chatStore';
import { BarButton } from './BarButton';
import { GaugeDial } from './GaugeDial';

// Shows the chat's reasoning level. A tap steps up one level and wraps from the
// highest to the lowest; a long press lists the levels by name.
export function EffortGauge() {
  const catalog = useChatStore(state => state.catalog);
  const picker = useChatStore(state => state.picker);
  const level = useChatStore(state => state.level);
  const setLevel = useChatStore(state => state.setLevel);

  const choice = resolveChoice(catalog, picker, level);
  if (choice.kind === 'auto') return null;
  const { levels } = choice.model;
  const index = levels.findIndex(option => option.key === choice.level);
  if (index < 0) return null;
  const next = levels[(index + 1) % levels.length];

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <BarButton
          onPress={() => setLevel(next.key)}
          accessibilityRole="button"
          accessibilityLabel="Reasoning effort"
          accessibilityValue={{ text: levels[index].label }}
          accessibilityHint="Double-tap to increase"
        >
          <GaugeDial
            fraction={levels.length > 1 ? index / (levels.length - 1) : 1}
          />
        </BarButton>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Label>Reasoning effort</ContextMenu.Label>
        {levels.map(option => (
          <ContextMenu.CheckboxItem
            key={option.key}
            value={option.key === choice.level ? 'on' : 'off'}
            onValueChange={() => setLevel(option.key)}
          >
            <ContextMenu.ItemIndicator />
            <ContextMenu.ItemTitle>{option.label}</ContextMenu.ItemTitle>
          </ContextMenu.CheckboxItem>
        ))}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
