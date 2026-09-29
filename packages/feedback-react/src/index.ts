/**
 * @jbenet/feedback-react — the feedback box from Capital OS, for any React app.
 *
 * Import the stylesheet once (`@jbenet/feedback-react/styles.css`), wrap the app in a
 * FeedbackProvider (optional), and mount a FeedbackButton in the layout.
 */
export {
  FeedbackProvider, useFeedbackConfig, resolveConfig, currentLocation, themeStyle, DEFAULT_SHORTCUT, GREEN_THEME,
  type FeedbackConfig, type FeedbackEndpoints, type FeedbackShortcut, type ResolvedFeedbackConfig,
} from './config';

// The box and its launcher
export { FeedbackButton, FeedbackDrawer, openFeedback, PRIORITY_MEANS, type Kind, type Priority } from './FeedbackBox';
export { FeedbackStatus, OutboxList, outboxSummary, useOutbox, type OutboxTone } from './FeedbackOutbox';
export { KeyboardShortcuts, ShortcutList, useShortcutPlatform } from './KeyboardShortcuts';

// Pieces, usable on their own
export { RegionPicker } from './RegionPicker';
export { ShotEditor } from './ShotEditor';
export { MarkdownField, packAttachments, type DroppedImage } from './MarkdownField';
export { Markdown, Spans } from './Markdown';
export { parseMarkdown, parseInline, type Block, type Inline } from './markdown-parse';
export {
  capturePage, capturePageExact, captureRender, METHOD_LABEL, type Capture, type CaptureMethod, type Region,
} from './capture';

// Storage and the wire
export {
  enqueue, startOutbox, configureOutbox, flushOutbox, retryNow, discardEntry, subscribe, snapshot,
  type OutboxState, type FiledNote, type ServerNote,
} from './outbox';
export {
  classify, settle, due, retryDelay, sendTimeout, firstLine, entryTitle, entryText, entryPictures, isClientId,
  BACKOFF_MS, BACKOFF_CAP_MS, SEND_TIMEOUT_MS, CLIENT_ID,
  type FeedbackRequest, type JournalEntry, type SendOutcome,
} from './journal';
export {
  readDraft, writeDraft, listDrafts, readPictures, writePictures, discardDraft, configureDrafts,
  type DraftWords, type DraftSummary, type DraftPictures,
} from './drafts';
export { newRequestKey } from './request-key';

// Keyboard and layout helpers
export {
  SHORTCUT_GROUPS, isFeedbackKey, isShortcutsKey, isTypingTarget, shortcutKeys, shortcutLabel, ariaShortcut,
  type ShortcutGroupId,
} from './keyboard';
export { useMedia, useModalSheet, useFocusTrap } from './useSheet';
export { VIEWPORT_BOOT, PHONE_MAX, PANE_MAX, PHONE_QUERY, PANE_QUERY, nextFocusIndex } from './viewport';

// The issues pages
export { IssueList, type LinkLike } from './issues/IssueList';
export { IssueDetail } from './issues/IssueDetail';
export { IssueVelocity } from './issues/IssueVelocity';
export { issueVelocity } from './issues/velocity';
export { IssuesPage, IssuePage } from './issues/IssuesPage';
export { useIssues, useIssue, patchIssue } from './issues/useIssues';
export {
  STATUSES, PRIORITIES, KINDS, PRIORITY,
  type Issue, type IssueStatus, type IssueKind, type IssuePriority,
} from './issues/types';
