import React, { useSyncExternalStore } from 'react';
import { Text } from 'react-native';
import { videoGenerationService } from '../services/videoGenerationService';
import { useTheme } from '../theme';
import { SPACING, TYPOGRAPHY } from '../constants';

/** Inline status below the pending reply. The composer owns Stop. */
export function VideoGenerationStatus({
  conversationId,
}: {
  conversationId?: string | null;
}) {
  const state = useSyncExternalStore(
    videoGenerationService.subscribe,
    videoGenerationService.getState,
  );
  const { colors } = useTheme();
  if (state.phase !== 'running' || state.conversationId !== conversationId)
    return null;
  const samplingFinished =
    state.progress && state.progress.step >= state.progress.total;
  const label =
    state.stage === 'enhancing'
      ? 'Preparing prompt'
      : state.stage === 'preparing'
      ? 'Loading video model'
      : state.stage === 'encoding'
      ? 'Saving video'
      : samplingFinished
      ? 'Finishing video'
      : 'Generating video';
  const steps =
    state.stage === 'generating' && state.progress && !samplingFinished
      ? ` · Step ${state.progress.step} of ${state.progress.total}`
      : '';
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{
        ...TYPOGRAPHY.bodySmall,
        color: colors.textSecondary,
        marginHorizontal: SPACING.lg,
        marginBottom: SPACING.sm,
      }}
    >
      {label}
      {steps}
    </Text>
  );
}
