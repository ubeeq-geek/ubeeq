import { useEffect, useRef } from 'react';
import { profileBioToText, sanitizeProfileBio } from './profile-bio.js';

export function LimitedBioEditor({
  value,
  onChange,
  maxLength,
  placeholder = ''
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder?: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const sanitizedValue = sanitizeProfileBio(value);
  const characterCount = profileBioToText(sanitizedValue).length;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor || editor.innerHTML === sanitizedValue) return;
    editor.innerHTML = sanitizedValue;
  }, [sanitizedValue]);

  const emitValue = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = sanitizeProfileBio(editor.innerHTML);
    if (profileBioToText(next).length > maxLength) {
      editor.innerHTML = sanitizedValue;
      return;
    }
    onChange(next);
  };

  const format = (command: 'bold' | 'italic' | 'underline') => {
    editorRef.current?.focus();
    document.execCommand(command);
    emitValue();
  };

  return (
    <div className="limited-bio-editor">
      <div className="limited-bio-toolbar" aria-label="Bio text formatting">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('bold')} aria-label="Bold"><strong>B</strong></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('italic')} aria-label="Italic"><em>I</em></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('underline')} aria-label="Underline"><u>U</u></button>
      </div>
      <div
        ref={(element) => {
          editorRef.current = element;
          if (element && document.activeElement !== element && element.innerHTML !== sanitizedValue) element.innerHTML = sanitizedValue;
        }}
        className="limited-bio-input"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emitValue}
        onBlur={emitValue}
        onPaste={(event) => {
          event.preventDefault();
          document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
          emitValue();
        }}
      />
      <div className="limited-bio-count">{characterCount} / {maxLength}</div>
    </div>
  );
}
