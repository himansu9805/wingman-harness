import { HStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import * as stylex from '@stylexjs/stylex';
import type { RunMetadata } from '../api/run-metadata';
import { runSummary, usageDetails } from '../state/run-summary';

export function RunSummary({ run }: { run: RunMetadata }) {
  if (run.status === 'running') return null;
  return <HStack gap={2} vAlign="center" xstyle={styles.footer}>
    <Text type="supporting">{runSummary(run).join(' · ')}</Text>
  </HStack>;
}
const styles = stylex.create({ footer: { marginTop: 'var(--spacing-3)' } });
