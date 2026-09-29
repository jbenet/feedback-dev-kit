'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor,
  type Editor, type ReactNodeViewProps,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { NodeSelection } from '@tiptap/pm/state';
import Image from '@tiptap/extension-image';
import { Markdown } from 'tiptap-markdown';

export interface DroppedImage {
  /** 1-based, and the same number the body's `attachment:N` refers to. */
  index: number;
  name: string;
  contentType: string;
  /** Data URL, for the preview here and for the POST. */
  dataUrl: string;
  /** Drawn on after it was dropped in (issue 0018). */
  annotated?: boolean;
}

const ACCEPT = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

type Mode = 'rich' | 'source';

/** The bits of prosemirror-markdown's serializer state this file uses. */
interface MdState { write(s: string): void; closeBlock(node: unknown): void; esc(s: string): string }

/** What the embed asks of the field around it. Refs, so the editor can be built once. */
interface EmbedActions {
  onAnnotate?: (index: number) => void;
  isAnnotated?: (index: number) => boolean;
}

/**
 * Which attachment an image in the rich view is.
 *
 * The rich view shows a data URL, and two identical pictures dropped twice have the same
 * one — so the data URL cannot say which `attachment:N` a node came from. The number rides
 * along in the image's title (`"attachment:2"`), which markdown carries through a parse and
 * a serialise untouched, and it is stripped back out before anything is stored.
 */
const TOKEN = /^attachment:(\d+)$/;
const indexOf = (title: unknown): number | null => {
  const m = typeof title === 'string' ? TOKEN.exec(title) : null;
  return m ? Number(m[1]) : null;
};

/**
 * A picture in the description, with its own Annotate and Remove (issue 0020).
 *
 * Annotating used to happen in a separate strip below the box that repeated every image —
 * one more thing to scroll past, and a list that went on showing a picture after it had
 * been deleted from the text. The buttons live on the picture now, where the eye already is.
 */
function Embed({ node, selected, deleteNode, extension }: ReactNodeViewProps) {
  const actions = extension.options as EmbedActions;
  const index = indexOf(node.attrs.title);
  const annotated = index !== null && actions.isAnnotated?.(index) === true;
  return (
    <NodeViewWrapper className={`mdembed${selected ? ' on' : ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={node.attrs.src as string} alt={(node.attrs.alt as string | null) ?? ''} draggable={false} />
      {index !== null && (
        <div className="mdembedbar" contentEditable={false}>
          {annotated && <span className="mdembedflag">annotated</span>}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => actions.onAnnotate?.(index)}
            title="Draw on this picture"
          >
            ✎ Annotate
          </button>
          <button
            type="button"
            className="x"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => deleteNode()}
            aria-label="Remove this picture"
            title="Remove it from the text — it will not be sent"
          >
            ×
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/**
 * An image is a block here, so it has to close its block when it is written out. The stock
 * serializer is prosemirror-markdown's inline one, which wrote the next paragraph straight
 * onto the image's line — `![shot](attachment:1)More words.` — and two dropped images onto
 * adjacent lines, so the issue file read back as a different document from the one typed.
 */
const BlockImage = Image.extend<EmbedActions & Record<string, unknown>>({
  addOptions() {
    return { ...this.parent?.(), onAnnotate: undefined, isAnnotated: undefined };
  },
  addNodeView() {
    return ReactNodeViewRenderer(Embed);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: MdState, node: { attrs: { alt?: string | null; src: string; title?: string | null } }) {
          const src = node.attrs.src.replace(/[()]/g, '\\$&');
          const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : '';
          state.write(`![${state.esc(node.attrs.alt ?? '')}](${src}${title})`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/**
 * Only the pictures still in the text are sent (issue 0020).
 *
 * Deleting an image from the description used to leave it in the upload — so dragging in the
 * wrong picture and deleting it still filed it. This keeps the pictures the text refers to,
 * in the order it refers to them, and renumbers the references to match, because the server
 * resolves `attachment:N` by position.
 */
export function packAttachments(body: string, images: DroppedImage[]): { body: string; images: DroppedImage[] } {
  const order: number[] = [];
  for (const m of body.matchAll(/\(attachment:(\d+)\)/g)) {
    const n = Number(m[1]);
    if (!order.includes(n) && images.some((i) => i.index === n)) order.push(n);
  }
  const renumber = new Map(order.map((n, k) => [n, k + 1]));
  return {
    body: body.replace(/\(attachment:(\d+)\)/g, (whole, n: string) =>
      (renumber.has(Number(n)) ? `(attachment:${renumber.get(Number(n))})` : whole)),
    images: order.map((n, k) => ({ ...images.find((i) => i.index === n)!, index: k + 1 })),
  };
}

/**
 * `tiptap-markdown` adds this to the editor's storage; its types do not declare it.
 *
 * With `html: false` it writes `<`, `>` and `&` in text as entities, so "(>100MB)" was filed
 * as "(&gt;100MB)" in issue 0021 — in the body and, through it, the title. The body is a
 * markdown file that people read in diffs, and the renderer builds React elements rather
 * than HTML, so the characters themselves are both safe and what was typed. `&amp;` goes
 * last, so a literal "&gt;" somebody typed survives as "&gt;".
 */
const serialise = (e: Editor): string =>
  (e.storage as unknown as { markdown: { getMarkdown(): string } }).markdown
    .getMarkdown()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * A markdown field you write in rather than at.
 *
 * Rich is the default, because most feedback is prose and asking somebody to remember
 * asterisks in order to file a bug is a tax on the complaint. **Source is one click away
 * and it is the real thing** — the body of an issue is a markdown file in this repository
 * and somebody will read it in a diff, so the source view is the document rather than an
 * export of it.
 *
 * Images are held as `attachment:N` references and never as data URLs in the text: the
 * sink owns the filenames, so the body cannot point at a path a caller chose. The rich
 * view swaps those tokens for the picture while you are typing and swaps them back when it
 * serialises.
 */
export function MarkdownField({
  value, onChange, images, onImages, onAnnotate, onPendingChange, placeholder, rows = 7, autoFocus = false, label,
}: {
  value: string;
  onChange: (next: string) => void;
  images: DroppedImage[];
  onImages: (next: DroppedImage[]) => void;
  /** Open the annotation editor on attachment N. The embed's button calls this. */
  onAnnotate?: (index: number) => void;
  onPendingChange?: (pending: boolean) => void;
  placeholder?: string;
  rows?: number;
  /** Put the cursor in the field when it is built: the feedback box opens straight into typing. */
  autoFocus?: boolean;
  /** The accessible name of the rich editor and the source textarea. */
  label?: string;
}) {
  const [mode, setMode] = useState<Mode>('rich');
  /**
   * While the Markdown tab is open, **the textarea is the document** (issue 0009).
   *
   * It used to be controlled by the same `value` the rich editor writes. Typing a space at
   * the end pushed the text through TipTap, which trimmed it, escaped backticks and handed
   * back a different string — so the field fought the typist, the cursor jumped to the end
   * and a fenced block could not be written at all. Source text now lives here until the
   * Rich tab is asked for.
   */
  const [source, setSource] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const pending = useRef(0);
  const [reading, setReading] = useState(false);
  const ingest = useRef(Promise.resolve());
  const latest = useRef({ mode, value, source });
  latest.current = { mode, value, source };
  /** Guards the loop: our own serialisation must not be fed back in as a new value. */
  const ours = useRef(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const annotateRef = useRef(onAnnotate);
  annotateRef.current = onAnnotate;

  /** `attachment:2` → the data URL sitting in this browser, and back again. */
  const toDisplay = (md: string) =>
    md.replace(/\(attachment:(\d+)\)/g, (whole, n: string) => {
      const hit = imagesRef.current.find((x) => x.index === Number(n));
      return hit ? `(${hit.dataUrl} "attachment:${hit.index}")` : whole;
    });
  const toStored = (md: string) => {
    let out = md;
    for (const img of imagesRef.current) {
      out = out
        .split(`(${img.dataUrl} "attachment:${img.index}")`).join(`(attachment:${img.index})`)
        .split(`(${img.dataUrl})`).join(`(attachment:${img.index})`);
    }
    return out;
  };

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    extensions: [
      // StarterKit carries Link in v3; adding it again registered two and warned about it.
      StarterKit.configure({ heading: { levels: [3, 4] }, link: { openOnClick: false } }),
      /* allowBase64: the pictures in the rich view are data URLs swapped in for the stored
         `attachment:N` tokens. With the default (false) TipTap refuses to parse them, so any
         rebuild from markdown — the Markdown→Rich toggle, or redrawing after an annotation —
         silently dropped every dropped-in image from the view while keeping it in the text. */
      BlockImage.configure({
        inline: false,
        allowBase64: true,
        onAnnotate: (i: number) => annotateRef.current?.(i),
        isAnnotated: (i: number) => imagesRef.current.find((x) => x.index === i)?.annotated === true,
      }),
      Markdown.configure({ html: false, transformPastedText: true, breaks: true }),
    ],
    content: toDisplay(value),
    editorProps: {
      attributes: {
        class: 'mdrich',
        'aria-label': label ?? 'What happened',
        'aria-multiline': 'true',
        role: 'textbox',
        style: `min-height:${rows * 22}px`,
      },
    },
    onUpdate: ({ editor: e }) => {
      ours.current = true;
      onChange(toStored(serialise(e)));
    },
  }, []);

  // A change from outside (a reset after filing) goes back into the editor. Never while the
  // Markdown tab is open, and never in a way that emits an update — that round trip is the
  // bug in issue 0009.
  useEffect(() => {
    if (!editor || mode === 'source') return;
    if (ours.current) { ours.current = false; return; }
    const current = toStored(serialise(editor));
    if (current !== value) editor.commands.setContent(toDisplay(value), { emitUpdate: false });
  }, [value, editor, mode]);

  /**
   * An image that was annotated after it was dropped in has a new data URL (issue 0018).
   * The rich view still shows the old one, and worse, would serialise it as a raw data URL
   * the next time anybody types — the old picture pasted straight into the markdown. So when
   * an image that already existed changes, the editor is redrawn from the stored text.
   * Adding an image does not trigger this: the editor already inserted it, and redrawing
   * would throw the cursor to the end.
   */
  const seen = useRef(new Map<number, string>());
  useEffect(() => {
    const changed = images.some((img) => {
      const before = seen.current.get(img.index);
      return before !== undefined && before !== img.dataUrl;
    });
    seen.current = new Map(images.map((img) => [img.index, img.dataUrl]));
    // Draft words can arrive before IndexedDB pictures. Resolve those tokens too.
    let unresolved = false;
    editor?.state.doc.descendants((node) => {
      if (node.type.name === 'image' && typeof node.attrs.src === 'string'
          && TOKEN.test(node.attrs.src) && images.some((img) => `attachment:${img.index}` === node.attrs.src)) unresolved = true;
    });
    if ((changed || unresolved) && editor && mode === 'rich') {
      editor.commands.setContent(toDisplay(source ?? value), { emitUpdate: false });
    }
  }, [images, editor, mode]);

  const inText = new Set([...(source ?? value).matchAll(/\(attachment:(\d+)\)/g)].map((m) => m[1])).size;

  const showSource = () => { setSource(value); setMode('source'); };
  const showRich = () => {
    const next = source ?? value;
    if (next !== value) onChange(next);
    editor?.commands.setContent(toDisplay(next), { emitUpdate: false });
    setSource(null);
    setMode('rich');
  };

  const insertFiles = async (files: File[]) => {
    setRefused(null);
    const usable = files.filter((f) => ACCEPT.has(f.type));
    const tooBig = usable.filter((f) => f.size > MAX_BYTES);
    const wrongKind = files.length - usable.length;
    if (wrongKind > 0 || tooBig.length > 0) {
      setRefused([
        wrongKind > 0 ? `${wrongKind} file${wrongKind === 1 ? '' : 's'} that ${wrongKind === 1 ? 'is' : 'are'} not a PNG, JPEG, GIF or WebP` : null,
        tooBig.length > 0 ? `${tooBig.length} over 8 MB` : null,
      ].filter(Boolean).join(' · '));
    }

    const keep = usable.filter((f) => f.size <= MAX_BYTES);
    if (keep.length === 0) return;

    const read = await Promise.all(keep.map((f) =>
      new Promise<DroppedImage | null>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve({
          index: 0, name: f.name || 'image', contentType: f.type, dataUrl: String(r.result),
        });
        r.onerror = () => resolve(null);
        r.readAsDataURL(f);
      })));

    const added = read.filter((x): x is DroppedImage => x !== null);
    if (added.length === 0) return;
    if (editor?.isDestroyed) return;
    const base = Math.max(0, ...imagesRef.current.map((img) => img.index));
    const numbered = added.map((x, i) => ({ ...x, index: base + i + 1 }));
    imagesRef.current = [...imagesRef.current, ...numbered];
    onImages(imagesRef.current);

    const currentMode = latest.current.mode;
    if (currentMode === 'rich' && editor) {
      /**
       * Each picture goes in followed by an empty paragraph, and the cursor ends up in it.
       * `setImage` left the new image *selected*, so the next picture dropped — or the second
       * file of a two-file drop — replaced it, and the first was gone from the report.
       */
      // Adding a file must not replace an image the reporter clicked to inspect.
      const selection = editor.state.selection;
      const at = selection instanceof NodeSelection && selection.node.type.name === 'image'
        ? selection.to : { from: selection.from, to: selection.to };
      editor.chain().focus().insertContentAt(at, numbered.flatMap((img) => [
        { type: 'image', attrs: { src: img.dataUrl, alt: img.name, title: `attachment:${img.index}` } },
        { type: 'paragraph' },
      ])).run();
    } else {
      // While the Markdown tab is open the textarea is the document, so the snippet has to
      // go into it — writing only the parent's copy left it invisible, and switching back to
      // Rich then overwrote the parent with the text that did not have it.
      const el = area.current;
      const current = latest.current.source ?? latest.current.value;
      const snippet = numbered.map((x) => `\n![${x.name}](attachment:${x.index})\n`).join('');
      const next = el
        ? current.slice(0, el.selectionStart) + snippet + current.slice(el.selectionEnd)
        : current + snippet;
      latest.current = { ...latest.current, source: next, value: next };
      setSource(next);
      onChange(next);
    }
  };

  // Read and insert batches in arrival order, including overlapping paste/drop events.
  const accept = (files: File[]) => {
    pending.current += 1;
    setReading(true);
    onPendingChange?.(true);
    ingest.current = ingest.current.then(() => insertFiles(files)).catch(() => {
      setRefused('An image could not be read. Try attaching it again.');
    }).finally(() => {
      pending.current -= 1;
      if (!pending.current) { setReading(false); onPendingChange?.(false); }
    });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    void accept([...e.dataTransfer.files]);
  };

  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    accept(files);
  };

  return (
    <div className={`mdfield${over ? ' over' : ''}`}>
      <div className="mdbar">
        <div className="mdtabs" role="group" aria-label="Rich text or markdown source">
          <button className={mode === 'rich' ? 'on' : ''} onClick={showRich} aria-pressed={mode === 'rich'}>
            Rich
          </button>
          <button className={mode === 'source' ? 'on' : ''} onClick={showSource} aria-pressed={mode === 'source'}>
            Markdown
          </button>
        </div>
        {mode === 'rich' && editor && <RichTools editor={editor} />}
        <button type="button" className="btn" onClick={() => picker.current?.click()}>Add images</button>
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
          aria-label="Add images" onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            if (files.length) accept(files);
          }} />
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        // Intercept files before ProseMirror handles accompanying HTML or its own drop.
        onDropCapture={onDrop}
        onPasteCapture={onPaste}
      >
        {mode === 'rich' ? (
          <div className="mdrichwrap">
            <EditorContent editor={editor} />
            {!value.trim() && placeholder && <div className="mdplaceholder" aria-hidden>{placeholder}</div>}
          </div>
        ) : (
          <textarea
            ref={area}
            rows={rows}
            value={source ?? value}
            placeholder={placeholder}
            aria-label={label ?? 'What happened'}
            spellCheck={false}
            onChange={(e) => {
              setSource(e.target.value);
              onChange(e.target.value);
            }}
          />
        )}
      </div>

      <p className="mdhint">
        {mode === 'rich'
          ? <>Rich text, stored as markdown. <b>Markdown</b> shows the file it becomes.</>
          : <>The markdown that is filed. <b>Rich</b> renders it.</>}
        {' '}<b>Drop or paste images</b> anywhere in this box.
        {inText > 0 && ` ${inText} in the text — only those are sent.`}
      </p>
      {reading && <p className="mdhint" role="status">Reading images…</p>}
      {refused && <p className="mdhint refused">Not attached: {refused}. Everything else went in.</p>}
    </div>
  );
}

const MARKS: Array<{ label: string; title: string; run: (e: Editor) => void; on: (e: Editor) => boolean }> = [
  { label: 'B', title: 'Bold', run: (e) => e.chain().focus().toggleBold().run(), on: (e) => e.isActive('bold') },
  { label: 'i', title: 'Italic', run: (e) => e.chain().focus().toggleItalic().run(), on: (e) => e.isActive('italic') },
  { label: '‹›', title: 'Code', run: (e) => e.chain().focus().toggleCode().run(), on: (e) => e.isActive('code') },
  { label: '#', title: 'Heading', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), on: (e) => e.isActive('heading', { level: 3 }) },
  { label: '•', title: 'Bullet list', run: (e) => e.chain().focus().toggleBulletList().run(), on: (e) => e.isActive('bulletList') },
  { label: '1.', title: 'Numbered list', run: (e) => e.chain().focus().toggleOrderedList().run(), on: (e) => e.isActive('orderedList') },
  { label: '“', title: 'Quote', run: (e) => e.chain().focus().toggleBlockquote().run(), on: (e) => e.isActive('blockquote') },
];

function RichTools({ editor }: { editor: Editor }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    editor.on('selectionUpdate', on);
    editor.on('transaction', on);
    return () => { editor.off('selectionUpdate', on); editor.off('transaction', on); };
  }, [editor]);

  return (
    <div className="mdtools">
      {MARKS.map((m) => (
        <button
          key={m.title}
          title={m.title}
          aria-label={m.title}
          aria-pressed={m.on(editor)}
          className={m.on(editor) ? 'on' : ''}
          onClick={() => m.run(editor)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
