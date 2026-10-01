import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';
import { AppSheet } from './AppSheet';
import { useThemedStyles } from '../theme';
import type { ThemeColors, ThemeShadows } from '../theme';
import { SPACING, TYPOGRAPHY, PRO_AHA_FEATURES } from '../constants';

interface ProAhaSheetProps {
  visible: boolean;
  onClose: () => void;
  onRegister: () => void;
}

export const ProAhaSheet: React.FC<ProAhaSheetProps> = ({ visible, onClose, onRegister }) => {
  const styles = useThemedStyles(createStyles);
  return (
    <AppSheet visible={visible} onClose={onClose}>
      <View style={styles.content}>
        <Text style={styles.headline}>Unlock Pro Features</Text>
        <Text style={styles.subheadline}>Pro is automatically unlocked</Text>
        <View style={styles.featureList}>
          {PRO_AHA_FEATURES.map((feature, index) => (
            <View key={`${String(feature)}-${index}`} style={styles.featureRow}>
              <Text style={styles.checkIcon}>✓</Text>
              <Text style={styles.featureText}>{String(feature)}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.subheadline}>Alright</Text>
        </TouchableOpacity>
      </View>
    </AppSheet>
  );
};

const createStyles = (colors: ThemeColors, _shadows: ThemeShadows): {
  content: ViewStyle;
  headline: TextStyle;
  subheadline: TextStyle;
  priceRow: ViewStyle;
  price: TextStyle;
  featureList: ViewStyle;
  featureRow: ViewStyle;
  checkIcon: TextStyle;
  featureText: TextStyle;
  guarantee: TextStyle;
  ctaButton: ViewStyle;
  ctaText: TextStyle;
} => ({
  content: {
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xxl,
    alignItems: 'center' as const,
  },
  headline: {
    ...TYPOGRAPHY.h2,
    color: colors.text,
    textAlign: 'center' as const,
    marginBottom: SPACING.sm,
  },
  subheadline: {
    ...TYPOGRAPHY.body,
    color: colors.textSecondary,
    textAlign: 'center' as const,
    marginBottom: SPACING.md,
  },
  priceRow: {
    marginBottom: SPACING.lg,
  },
  price: {
    ...TYPOGRAPHY.bodySmall,
    color: colors.primary,
    textAlign: 'center' as const,
  },
  featureList: {
    width: '100%' as const,
    marginBottom: SPACING.lg,
    gap: SPACING.sm,
  },
  featureRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACING.sm,
  },
  checkIcon: {
    color: colors.primary,
  },
  featureText: {
    ...TYPOGRAPHY.body,
    color: colors.text,
  },
  guarantee: {
    ...TYPOGRAPHY.bodySmall,
    color: colors.textMuted,
    textAlign: 'center' as const,
    marginBottom: SPACING.lg,
  },
  ctaButton: {
    width: '100%' as const,
    paddingVertical: SPACING.md,
    backgroundColor: colors.primary,
    borderRadius: 8,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginBottom: SPACING.sm,
  },
  ctaText: {
    ...TYPOGRAPHY.body,
    color: colors.background,
  },
});
