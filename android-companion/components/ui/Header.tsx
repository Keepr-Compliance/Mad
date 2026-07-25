import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { spacing } from '../../theme/spacing';
import Wordmark from './Wordmark';

interface HeaderAction {
  /** Text or emoji icon for the button */
  icon: string;
  onPress: () => void;
  /** Accessibility label */
  accessibilityLabel: string;
}

interface HeaderProps {
  title: string;
  leftActions?: HeaderAction[];
  rightActions?: HeaderAction[];
  /**
   * Render the Keepr brand wordmark in place of the plain title text
   * (the home/brand header). Sub-page headers ("Account", "Settings") leave
   * this off and show the plain title. BACKLOG-2246.
   */
  showWordmark?: boolean;
  /**
   * Custom node rendered in the right slot (e.g. the profile Avatar), used
   * instead of `rightActions`. BACKLOG-2254.
   */
  rightElement?: React.ReactNode;
}

export default function Header({
  title,
  leftActions = [],
  rightActions = [],
  showWordmark = false,
  rightElement,
}: HeaderProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      {/* Left actions */}
      <View style={styles.actions}>
        {leftActions.map((action, i) => (
          <TouchableOpacity
            key={i}
            onPress={action.onPress}
            style={styles.actionButton}
            accessibilityLabel={action.accessibilityLabel}
            accessibilityRole="button"
          >
            <Text style={styles.actionIcon}>{action.icon}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Title — brand wordmark on the home header, plain text elsewhere */}
      {showWordmark ? (
        <View style={styles.titleWrap}>
          <Wordmark size={22} />
        </View>
      ) : (
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      )}

      {/* Right slot — custom element (Avatar) or action buttons */}
      <View style={[styles.actions, styles.actionsRight]}>
        {rightElement ??
          rightActions.map((action, i) => (
            <TouchableOpacity
              key={i}
              onPress={action.onPress}
              style={styles.actionButton}
              accessibilityLabel={action.accessibilityLabel}
              accessibilityRole="button"
            >
              <Text style={styles.actionIcon}>{action.icon}</Text>
            </TouchableOpacity>
          ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray[200],
  },
  title: {
    ...textStyles.subheading,
    color: colors.gray[900],
    flex: 1,
    textAlign: 'center',
  },
  titleWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 48,
  },
  actionsRight: {
    justifyContent: 'flex-end',
  },
  actionButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  actionIcon: {
    fontSize: 22,
  },
});
