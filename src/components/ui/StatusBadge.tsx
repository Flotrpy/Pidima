import { STATUS_META, type ProposalState } from "./status";

export function StatusBadge({ state }: { state: ProposalState }) {
  const meta = STATUS_META[state];
  return (
    <span className={`badge badge-${meta.tone}`}>
      <span aria-hidden="true">{meta.icon}</span>
      <span>{meta.label}</span>
    </span>
  );
}
