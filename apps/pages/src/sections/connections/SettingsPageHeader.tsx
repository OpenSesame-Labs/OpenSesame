import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { DocLink } from "@opensesame/app-core/lib/doc-link.js";
import { IconExternal } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useOptionalGuideTarget } from "../../tutorial/registry/react.jsx";
import { BackupEnableSwitch, canBackupEnable } from "./BackupEnableSwitch.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { GithubAppForgetButton } from "./GithubAppConfigRows.js";
import type { ConnectorTitleStatus } from "./SettingsPageStatus.js";

export function SettingsPageHeader({
  provider,
  status,
  sentence,
  docs,
  canForgetApp,
}: {
  provider: Provider;
  status: ConnectorTitleStatus;
  sentence: string;
  docs: DocLink | null;
  canForgetApp: boolean;
}) {
  const githubRef = useOptionalGuideTarget<HTMLDivElement>(
    provider.id === "github" ? "connections.github.backup" : undefined,
  );
  return (
    <header className="conn-settings__head">
      <ConnectorMark
        providerId={provider.id}
        displayName={provider.displayName}
        size={44}
      />
      <div className="conn-settings__title">
        <div className="conn-settings__name" ref={githubRef}>
          <h1>{provider.displayName}</h1>
          <StatusMark {...status} />
          {canBackupEnable(provider.id) ? (
            <BackupEnableSwitch
              providerId={provider.id}
              displayName={provider.displayName}
              showSetupHint={provider.id === "github"}
            />
          ) : null}
          {canForgetApp ? <GithubAppForgetButton /> : null}
        </div>
        <p>{sentence}</p>
      </div>
      {docs ? (
        <a
          className="btn btn--sm btn--ghost"
          href={docs.url}
          target="_blank"
          rel="noreferrer noopener"
          title={docs.label}
        >
          {docs.short} <IconExternal size={14} />
        </a>
      ) : null}
    </header>
  );
}
