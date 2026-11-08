import { useCallback, useEffect, useRef, useState } from "react";
import type { SupportEntry } from "../session.js";

/**
 * Keep a support exchange in sight on a phone, where the question a person
 * taps sits below the conversation it appends to — without this, asking
 * looks like nothing happened.
 *
 * The rule is causal, and it is the sheet body's own scroll only (never
 * `scrollIntoView`, which would drag the page behind the sheet): when the
 * person's own question lands, scroll once, instantly, so that question is
 * at the top of the body and its answer reads under it. An answer or note
 * arriving on its own never moves the viewport — if it lands below the
 * fold it offers a "New answer" key instead, so reading an older answer is
 * never interrupted. Focus never moves; the live region still announces.
 */
export function useSupportScroll(transcript: readonly SupportEntry[]) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  const seen = useRef(0);
  const [unseenAnswer, setUnseenAnswer] = useState(false);

  const articleAt = useCallback((index: number): HTMLElement | null => {
    const node = threadRef.current?.children[index];
    return node instanceof HTMLElement ? node : null;
  }, []);

  /** Scroll the sheet body so `article`'s top meets the body's top. */
  const bringToTop = useCallback((article: HTMLElement) => {
    const body = bodyRef.current;
    if (!body) return;
    const delta =
      article.getBoundingClientRect().top - body.getBoundingClientRect().top;
    const top = body.scrollTop + delta;
    // Not every engine implements element scrollTo (jsdom does not).
    if (body.scrollTo) {
      body.scrollTo({ top, behavior: "instant" });
    } else {
      body.scrollTop = top;
    }
  }, []);

  // A question asked while another tab is up has no article yet — the
  // panel flips to the conversation on the same change, so the scroll is
  // owed, not dropped, and is paid on the render that mounts the thread.
  const owed = useRef<number | null>(null);
  useEffect(() => {
    if (owed.current === null) return;
    const article = articleAt(owed.current);
    if (!article) return;
    owed.current = null;
    bringToTop(article);
  });

  useEffect(() => {
    const from = seen.current;
    const grew = transcript.length > from;
    const last = transcript[transcript.length - 1];
    const shrank = transcript.length < from;
    seen.current = transcript.length;
    if (shrank) setUnseenAnswer(false);
    if (!grew || !last) return;
    // The person's own question may not be the last entry: written help
    // appends the question and its answer in one breath. The newest
    // question among what just landed is still the causal one — scroll
    // to it and let its answer read under it.
    let questionAt = -1;
    for (let index = transcript.length - 1; index >= from; index -= 1) {
      if (transcript[index]?.kind === "question") {
        questionAt = index;
        break;
      }
    }
    if (questionAt >= 0) owed.current = questionAt;
    const article = articleAt(
      questionAt >= 0 ? questionAt : transcript.length - 1,
    );
    if (!article) return;
    if (questionAt >= 0) {
      setUnseenAnswer(false);
      owed.current = null;
      bringToTop(article);
      return;
    }
    // An async arrival: offer the jump only when it is actually out of sight.
    const body = bodyRef.current;
    if (!body) return;
    const belowFold =
      article.getBoundingClientRect().bottom >
      body.getBoundingClientRect().bottom;
    if (belowFold) setUnseenAnswer(true);
  }, [transcript, articleAt, bringToTop]);

  /** The "New answer" key: jump to the newest entry, then stand down. */
  const jumpToAnswer = useCallback(() => {
    const article = articleAt(seen.current - 1);
    if (article) bringToTop(article);
    setUnseenAnswer(false);
  }, [articleAt, bringToTop]);

  /** Reading down to the answer by hand clears the offer. */
  const onBodyScroll = useCallback(() => {
    if (!unseenAnswer) return;
    const body = bodyRef.current;
    const article = articleAt(seen.current - 1);
    if (!body || !article) return;
    if (
      article.getBoundingClientRect().bottom <=
      body.getBoundingClientRect().bottom
    ) {
      setUnseenAnswer(false);
    }
  }, [unseenAnswer, articleAt]);

  return { bodyRef, threadRef, unseenAnswer, jumpToAnswer, onBodyScroll };
}
