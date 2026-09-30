import type { ReactNode } from "react";

/** Static sample of the real review screen. Labelled so it is never mistaken for live data. */
export function PreviewCard({
  title = "Handle failed webhook retries",
  footer,
  status,
}: {
  title?: string;
  footer?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div
      className="mk-card"
      role="group"
      aria-label="Product preview: sample GitHub issue proposal"
    >
      <div className="mk-card-tag">Product preview · sample data</div>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <strong>Claude wants to create a GitHub issue</strong>
        {status}
      </div>
      <dl className="mk-facts">
        <div>
          <dt>Repository</dt>
          <dd className="mono">acme/platform</dd>
        </div>
        <div>
          <dt>Title</dt>
          <dd>{title}</dd>
        </div>
        <div>
          <dt>Body</dt>
          <dd>
            Retries are dropped after the third failed delivery. Reproduce with a 500 from the
            receiver…
          </dd>
        </div>
        <div>
          <dt>Requested by</dt>
          <dd>Maya Chen through Claude</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>In 27 minutes</dd>
        </div>
      </dl>
      {footer}
    </div>
  );
}
