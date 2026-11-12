import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import * as stylex from "@stylexjs/stylex";
import type { RunMetadata } from "../../../shared/contracts/run-metadata";
import { runSummary, usageDetails } from "../model/run-summary";

/** Display terminal run timing and usage, with a tooltip for the backend breakdown. */
export function RunSummary({ run }: { run: RunMetadata }) {
  if (run.status === "running") return null;
  return (
    <Text type="supporting" tabIndex={0} xstyle={styles.footer}>
      {runSummary(run).join(" · ")}
    </Text>
  );
}
const styles = stylex.create({ footer: { marginTop: "var(--spacing-2)" } });
