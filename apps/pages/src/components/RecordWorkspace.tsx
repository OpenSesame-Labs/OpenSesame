import { AscendProvider } from "../lib/pane-trail.js";
import { IconChevronLeft } from "./Icons.js";
import { NavTree } from "./NavTree.js";
import { RecordAdd } from "./RecordAdd.js";
import { RecordList } from "./RecordList.js";
import {
  type RecordWorkspaceProps,
  countedWorkspaceRows,
} from "./record-workspace-contract.js";
import { useRecordWorkspace } from "./record-workspace-state.js";
import { UpLink } from "./UpLink.js";
import "../sections/vault.css";
import "./record-workspace.css";

export type {
  RecordWorkspaceProps,
  WorkspaceRow,
} from "./record-workspace-contract.js";

/** The vault layout shared by record sections. */
export function RecordWorkspace(props: RecordWorkspaceProps) {
  const {
    section,
    title,
    listPath,
    selectedId,
    detailOpen = false,
    status,
    children,
    rows,
  } = props;
  const model = useRecordWorkspace(props);
  const { narrow, treePane, detail, pane, ascend, createLabel } = model;
  return (
    <AscendProvider value={narrow ? ascend : null}>
      <div
        className="vault record-workspace"
        data-pane={pane}
        data-section={section}
      >
        <div className="vault__tree" ref={treePane}>
          {narrow ? <NavTree /> : null}
        </div>
        <RecordList {...props} model={model} />
        <div className="vault__detail" ref={detail} tabIndex={-1}>
          {status}
          {selectedId !== null || detailOpen ? (
            <>
              <UpLink
                pane="list"
                to={listPath}
                data-pane-close=""
                className="icon-btn detail__backbtn record-workspace__back"
                aria-label={`Back to ${title.toLowerCase()}`}
                title={`Back to ${title.toLowerCase()}`}
              >
                <IconChevronLeft size={18} />
              </UpLink>
              {children}
            </>
          ) : (
            <div className="buffer">
              <p className="buffer__line">
                {countedWorkspaceRows(rows).length} {title.toLowerCase()}
              </p>
            </div>
          )}
        </div>
        {narrow && pane === "list" && createLabel ? (
          <RecordAdd model={model} guide={props.createGuide} />
        ) : null}
      </div>
    </AscendProvider>
  );
}
