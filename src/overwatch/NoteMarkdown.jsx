import React from "react";
import { Link } from "react-router-dom";
import { RECORD_LINK_BASE } from "../shared/copyRecord";

// The small markdown Overwatch's notes use: # to ### headings, - * and 1. lists, paragraphs,
// **bold**, `code`, [text](url) and bare URLs. Built as React elements, never as HTML.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;

function NoteLink({ href, children }) {
  // Alfred's own links stay in the app; anything else opens a new tab.
  if (href.startsWith(RECORD_LINK_BASE)) {
    return (
      <Link to={`/${href.slice(RECORD_LINK_BASE.length)}`} className="text-primary hover:text-primary-hover underline">
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:text-primary-hover underline">
      {children}
    </a>
  );
}

export function renderInline(text) {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i} className="px-1 rounded bg-secondary text-xs">{part.slice(1, -1)}</code>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return <NoteLink key={i} href={link[2]}>{link[1]}</NoteLink>;
    if (/^https?:\/\//.test(part)) return <NoteLink key={i} href={part}>{part}</NoteLink>;
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

/** Lines into blocks: headings, lists (ordered or not) and paragraphs. */
export function parseBlocks(text) {
  const blocks = [];
  let para = null;
  let list = null;
  const close = () => { para = null; list = null; };
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      close();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      para = null;
      if (!list || list.ordered !== ordered) {
        list = { type: "list", ordered, items: [] };
        blocks.push(list);
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    list = null;
    if (para) para.text += ` ${line}`;
    else {
      para = { type: "paragraph", text: line };
      blocks.push(para);
    }
  }
  return blocks;
}

const HEADING_CLASS = {
  1: "text-base sm:text-lg font-semibold text-foreground",
  2: "text-base font-medium text-foreground",
  3: "text-sm font-medium text-foreground",
};

export default function NoteMarkdown({ text }) {
  return (
    <div className="space-y-2 text-sm text-foreground">
      {parseBlocks(text).map((b, i) => {
        if (b.type === "heading") {
          const Tag = `h${b.level + 2}`;
          return <Tag key={i} className={`m-0 ${HEADING_CLASS[b.level]}`}>{renderInline(b.text)}</Tag>;
        }
        if (b.type === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag key={i} className={`m-0 pl-5 space-y-1 ${b.ordered ? "list-decimal" : "list-disc"}`}>
              {b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
            </Tag>
          );
        }
        return <p key={i} className="m-0">{renderInline(b.text)}</p>;
      })}
    </div>
  );
}
