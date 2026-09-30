import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card } from '../components';
import { LoadingDots } from '../components/LoadingDots';
import { SLOTS, useSlot } from '../bootstrap/slotRegistry';
import { SPACING, TYPOGRAPHY } from '../constants';
import type { RootStackParamList } from '../navigation/types';
import type { AutoSetupItem, AutoSetupTier } from '../services/autoSetupPlan';
import {
  autoSetupDownloadId,
  createAutoSetupSession,
  type AutoSetupSession,
} from '../services/autoSetupService';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors, ThemeShadows } from '../theme';

const productionSessionFactory = (): AutoSetupSession =>
  createAutoSetupSession();

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AutoSetup'>;
  /** Tests may create the real session with native/network boundary fakes. */
  sessionFactory?: () => AutoSetupSession;
};

const labelForItem = (item: AutoSetupItem) => {
  if (item.kind === 'text') return 'TEXT';
  if (item.kind === 'image') return 'IMAGE';
  if (item.kind === 'video') return 'VIDEO';
  if (item.kind === 'embedding') return 'SEARCH';
  return 'SPEECH';
};

export const AutoSetupScreen: React.FC<Props> = ({
  navigation,
  sessionFactory = productionSessionFactory,
}) => {
  const session = useMemo(() => sessionFactory(), [sessionFactory]);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const VoiceIndicator = useSlot(SLOTS.autoSetupVoiceIndicator);
  const [expandedTier, setExpandedTier] = useState<AutoSetupTier | null>(
    () => session.snapshot().selectedTier,
  );

  useEffect(() => {
    session.load().catch(() => undefined);
    return () => session.dispose();
  }, [session]);

  const selected =
    snapshot.plans.find(plan => plan.tier === snapshot.selectedTier) ??
    snapshot.plans[0];
  const selectedItems = [...(selected?.items ?? []), ...(selected?.embedding ? [selected.embedding] : [])].filter(item =>
    snapshot.selectedKinds.includes(item.kind),
  );
  const selectedBytes = selectedItems.reduce(
    (total, item) => total + (
      snapshot.installedIds.includes(autoSetupDownloadId(item)) ? 0 : item.sizeBytes
    ), 0,
  );
  const selectedOutcomes =
    selectedItems.map(item => snapshot.outcomes[autoSetupDownloadId(item)]);
  const progress =
    selectedOutcomes.length === 0
      ? 0
      : selectedOutcomes.reduce(
          (sum, outcome) => sum + (outcome?.progress ?? 0),
          0,
        ) / selectedOutcomes.length;
  const isComplete = snapshot.phase === 'completed';
  const starting = snapshot.phase === 'downloading';

  if (snapshot.phase === 'loading_catalog')
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <LoadingDots color={colors.primary} />
          <Text style={styles.secondary}>
            Finding model choices...
          </Text>
        </View>
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        testID="auto-setup-screen"
      >
        <Text style={styles.eyebrow}>AUTO SETUP</Text>
        <Text style={styles.title}>Choose model downloads.</Text>
        <Text style={styles.secondary}>
          Check the models you want. The total excludes models already on this
          device.
        </Text>

        {snapshot.error && (
          <Card style={styles.errorCard}>
            <Text style={styles.error}>{snapshot.error}</Text>
            <Button
              title="Try Again"
              onPress={() => {
                if (snapshot.plans.length)
                  session.start().catch(() => undefined);
                else session.load().catch(() => undefined);
              }}
              variant="outline"
              testID="auto-setup-retry"
            />
          </Card>
        )}

        <View style={styles.planGrid}>
          {snapshot.plans.map(plan => (
            <Card
              key={plan.tier}
              onPress={starting ? undefined : () => {
                if (expandedTier === plan.tier) {
                  setExpandedTier(null);
                  return;
                }
                if (selected?.tier !== plan.tier) session.selectTier(plan.tier);
                setExpandedTier(plan.tier);
              }}
              style={{
                ...styles.planCard,
                ...(selected?.tier === plan.tier ? styles.selectedCard : {}),
              }}
              testID={`auto-setup-plan-${plan.tier}`}
            >
              <Text style={styles.planTitle}>{plan.title}</Text>
              <Text style={styles.secondary}>{plan.summary}</Text>
              {expandedTier === plan.tier && (
                <View
                  style={styles.expandedPlan}
                  testID="auto-setup-selected-plan"
                >
                  <Text style={styles.includesLabel}>CHOOSE MODELS</Text>
                  <View style={styles.planItems}>
                    {[...plan.items, ...(plan.embedding ? [plan.embedding] : [])].map(item => {
                      const checked = snapshot.selectedKinds.includes(item.kind);
                      const installed = snapshot.installedIds.includes(autoSetupDownloadId(item));
                      const size = item.kind === 'embedding' && item.sizeBytes === 0
                        ? 'Included' : formatBytes(item.sizeBytes);
                      return (
                        <Card
                          key={`${plan.tier}:${item.kind}:${item.id}`}
                          style={styles.planItem}
                        >
                          <Button
                            title=""
                            icon={<Icon name={checked ? 'check-square' : 'square'} size={20} color={checked ? colors.primary : colors.textSecondary} />}
                            variant="ghost"
                            size="small"
                            active={checked}
                            style={styles.choiceControl}
                            onPress={() => session.toggleKind(item.kind)}
                            disabled={starting}
                            accessibilityRole="checkbox"
                            accessibilityLabel={`Include ${item.name}, ${size}${installed ? ', already downloaded' : ''}`}
                            accessibilityState={{ checked, disabled: starting }}
                            testID={`auto-setup-choice-${item.kind}`}
                          />
                          <Text style={styles.itemKind}>{labelForItem(item)}</Text>
                          <Text style={styles.planItemName} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={styles.itemSize}>
                            {size}{installed ? '' : outcomeLabel(snapshot.outcomes[autoSetupDownloadId(item)])}
                          </Text>
                        </Card>
                      );
                    })}
                    {!plan.items[3] && (
                      <View style={styles.unavailableItem}>
                        <Text style={styles.itemKind}>VIDEO</Text>
                        <Text style={styles.itemSize}>
                          {plan.videoExclusionReason ?? 'No video model is included in this Auto Setup plan.'}
                        </Text>
                      </View>
                    )}
                    {VoiceIndicator ? (
                      <VoiceIndicator
                        onPress={() => navigation.push('ProDetail')}
                        style={styles.voiceItem}
                      />
                    ) : null}
                  </View>
                  <Text style={styles.total}>
                    {formatBytes(selectedBytes)} selected download
                  </Text>
                  {(starting || selectedOutcomes.length > 0) && (
                    <View style={styles.progressTrack}>
                      <View
                        style={[
                          styles.progressFill,
                          { width: `${Math.max(2, progress * 100)}%` },
                        ]}
                      />
                    </View>
                  )}
                  {isComplete ? (
                    <Button
                      title="Continue"
                      onPress={() => {
                        session.complete();
                        navigation.replace('Main');
                      }}
                      testID="auto-setup-continue"
                    />
                  ) : (
                    <Button
                      title={
                        snapshot.phase === 'failed'
                          ? 'Retry Downloads'
                          : selectedBytes === 0 ? 'Use selected models'
                          : `Download ${formatBytes(selectedBytes)}`
                      }
                      onPress={() => {
                        session.start().catch(() => undefined);
                      }}
                      loading={starting}
                      disabled={selectedItems.length === 0}
                      testID="auto-setup-download"
                    />
                  )}
                  {starting && (
                    <Button
                      title="Stop Downloads"
                      variant="outline"
                      onPress={() => { session.cancel().catch(() => undefined); }}
                      testID="auto-setup-cancel"
                    />
                  )}
                </View>
              )}
            </Card>
          ))}
        </View>

        {!selected && (
          <Card style={styles.errorCard}>
            <Text style={styles.error}>
              Auto Setup could not find the models it needs to show a plan.
            </Text>
          </Card>
        )}

        <Button
          title="Configure it yourself"
          variant="ghost"
          onPress={() => navigation.push('AdvancedSetup')}
          testID="auto-setup-advanced"
        />
        <Button
          title="Skip for Now"
          variant="ghost"
          onPress={() => navigation.replace('Main')}
          testID="auto-setup-skip"
        />
      </ScrollView>
    </SafeAreaView>
  );
};

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function outcomeLabel(
  outcome:
    | ReturnType<AutoSetupSession['snapshot']>['outcomes'][string]
    | undefined,
): string {
  if (!outcome) return '';
  if (outcome.phase === 'completed') return ' - READY';
  if (outcome.phase === 'failed') return ' - FAILED';
  if (outcome.phase === 'cancelled') return ' - CANCELLED';
  if (outcome.phase === 'starting') return ' - STARTING';
  if (outcome.phase === 'downloading')
    return ` - ${Math.round(outcome.progress * 100)}%`;
  return '';
}

const createStyles = (colors: ThemeColors, _shadows: ThemeShadows) => ({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xxl,
    gap: SPACING.md,
  },
  center: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: SPACING.md,
    padding: SPACING.xl,
  },
  eyebrow: { ...TYPOGRAPHY.label, color: colors.primary },
  title: { ...TYPOGRAPHY.h2, color: colors.text },
  secondary: { ...TYPOGRAPHY.body, color: colors.textSecondary },
  planGrid: { gap: SPACING.sm },
  planCard: {
    borderWidth: 1,
    borderColor: colors.border,
    gap: SPACING.xs,
    padding: SPACING.md,
    borderRadius: SPACING.sm,
  },
  selectedCard: { borderColor: colors.primary },
  planTitle: { ...TYPOGRAPHY.h3, color: colors.text },
  expandedPlan: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: SPACING.xs,
    paddingTop: SPACING.sm,
    gap: SPACING.sm,
  },
  includesLabel: { ...TYPOGRAPHY.labelSmall, color: colors.textMuted },
  planItems: { gap: SPACING.sm },
  planItem: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: SPACING.sm,
    backgroundColor: colors.surfaceLight,
  },
  unavailableItem: {
    padding: SPACING.sm,
    gap: SPACING.xs,
  },
  voiceItem: {
    padding: SPACING.sm,
    gap: SPACING.xs,
    borderRadius: SPACING.sm,
    backgroundColor: colors.surfaceLight,
  },
  choiceControl: {
    width: 44,
    height: 44,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  planItemName: {
    ...TYPOGRAPHY.body,
    color: colors.text,
    flex: 1,
    minWidth: 0,
  },
  itemSize: {
    ...TYPOGRAPHY.meta,
    color: colors.textSecondary,
    flexShrink: 0,
  },
  total: { ...TYPOGRAPHY.meta, color: colors.primary },
  itemKind: { ...TYPOGRAPHY.labelSmall, color: colors.textMuted, width: 48 },
  progressTrack: {
    height: SPACING.xs,
    backgroundColor: colors.surfaceLight,
    overflow: 'hidden' as const,
  },
  progressFill: { height: SPACING.xs, backgroundColor: colors.primary },
  errorCard: { gap: SPACING.md, borderWidth: 1, borderColor: colors.error },
  error: { ...TYPOGRAPHY.body, color: colors.error },
});
