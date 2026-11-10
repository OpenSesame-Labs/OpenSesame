import {
  SAVE_REQUEST_TYPES,
  type SaveRequest,
  type SaveRequestType,
  decodeSaveRequest,
} from "@opensesame/app-core/lib/save-request.js";
import { type JsonValue, isString } from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import { FailureNotice } from "../components/FailureNotice.js";
import { FormCommit } from "../components/FormCommit.js";
import { IconKey } from "../components/IconKey.js";
import { IconEye, IconEyeOff, IconX } from "../components/Icons.js";
import { useVaultStore } from "../lib/vault/hooks.js";
import { buildSaveItem } from "./save-request-item.js";

const CONCEALED = new Set([
  "current-password",
  "password",
  "cc-number",
  "cc-csc",
  "crypto-recovery-seed",
  "one-time-code",
]);

const TYPES = new Set<string>(SAVE_REQUEST_TYPES);

function isType(value: JsonValue | undefined): value is SaveRequestType {
  return isString(value) && TYPES.has(value);
}

function sourceOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function label(autocomplete: string): string {
  return autocomplete
    .replaceAll(/[-_]/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function SaveRequestScreen() {
  const store = useVaultStore();
  const [request, setRequest] = useState<SaveRequest | null>(null);
  const [type, setType] = useState<SaveRequestType>("login");
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    const opener: Window | null = window.opener;
    if (!opener) {
      setError("Open this page from a site's Save in OpenSesame button.");
      return;
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const origin = sourceOrigin(event.origin);
      if (!origin) return;
      const data = event.data;
      if (data?.type === "opensesame.save.request") {
        const decoded = decodeSaveRequest(String(data.request ?? ""));
        if (!decoded || !isType(data.itemType)) {
          opener.postMessage(
            {
              type: "opensesame.save.failed",
              message: "The save request could not be read.",
            },
            origin,
          );
          setError(
            "The save request could not be read. Ask the site to try again.",
          );
          return;
        }
        setRequest(decoded);
        setTitle(decoded.title);
        setType(data.itemType);
        setSource(origin);
      }
    };
    window.addEventListener("message", receive);
    opener.postMessage({ type: "opensesame.save.ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, []);

  const toggle = (key: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function save() {
    if (!request || !source) return;
    setBusy(true);
    setError(null);
    try {
      const result = await buildSaveItem(
        { ...request, title: title.trim() || request.title },
        type,
        source,
        store,
      );
      if ("error" in result) {
        setError(result.error);
        window.opener?.postMessage(
          { type: "opensesame.save.failed", message: result.error },
          source,
        );
        return;
      }
      await store.saveItem(result.item);
      setSavedId(result.item.id);
      window.opener?.postMessage(
        { type: "opensesame.save.saved", itemId: result.item.id },
        source,
      );
    } catch {
      const message = "The item could not be saved. Nothing was changed.";
      setError(message);
      window.opener?.postMessage(
        { type: "opensesame.save.failed", message },
        source,
      );
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (!savedId) {
      window.opener?.postMessage(
        { type: "opensesame.save.failed", message: "Save cancelled." },
        source || "*",
      );
    }
    window.close();
  }

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Save in OpenSesame</h1>
      </header>
      <FailureNotice
        id="save-request"
        title="Save in OpenSesame"
        message={error}
      />
      {!request && !error ? <p className="hint">Waiting…</p> : null}
      {request && !savedId ? (
        <>
          <p className="hint">
            From <strong>{source}</strong>
          </p>
          <label className="label" htmlFor="save-title">
            Name
          </label>
          <input
            id="save-title"
            className="input"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
          <section className="detail__group" aria-label="Fields to save">
            <h2 className="detail__grouphead">Fields</h2>
            {request.fields.map((field, index) => {
              const key = `${index}:${field.autocomplete}`;
              const concealed = CONCEALED.has(field.autocomplete);
              return (
                <div className="frow" key={key}>
                  <div className="frow__text">
                    <span className="frow__label">
                      {label(field.autocomplete)}
                    </span>
                    <span className="frow__value">
                      {concealed && !revealed.has(key)
                        ? "••••••••"
                        : field.value}
                    </span>
                  </div>
                  {concealed ? (
                    <div className="frow__actions">
                      <IconKey
                        small
                        label={`${revealed.has(key) ? "Hide" : "Show"} ${label(field.autocomplete)}`}
                        aria-pressed={revealed.has(key)}
                        onClick={() => toggle(key)}
                      >
                        {revealed.has(key) ? (
                          <IconEyeOff size={16} />
                        ) : (
                          <IconEye size={16} />
                        )}
                      </IconKey>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
          {request.notes ? (
            <section className="detail__group">
              <h2 className="detail__grouphead">Notes</h2>
              <p className="frow__notes">{request.notes}</p>
            </section>
          ) : null}
          <FormCommit
            label="Save"
            busy={busy}
            disabled={busy}
            onClick={() => void save()}
          >
            <IconKey label="Cancel" disabled={busy} onClick={close}>
              <IconX size={16} />
            </IconKey>
          </FormCommit>
        </>
      ) : null}
      {savedId ? (
        <div className="actions">
          <output className="hint">Saved to this vault.</output>
          <a
            className="btn btn--sm"
            href={`${import.meta.env.BASE_URL}vault/${savedId}`}
          >
            Open item
          </a>
          <IconKey label="Close" onClick={close}>
            <IconX size={16} />
          </IconKey>
        </div>
      ) : null}
    </div>
  );
}
